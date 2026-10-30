// Live Poll server -- zero external dependencies, just Node's built-ins.
// Run with: node server.js   (or: npm start)
//
// Privacy design:
//  * Poll votes are stored on disk (data/data.json) keyed only by the last-4-digit code.
//  * The survey data file is uploaded by the instructor and held in server MEMORY ONLY.
//    It is never written to disk, never logged, and disappears on restart.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { parseCSV, toCSV } = require('./lib/csv');
const { parseSurveyExport, UploadError } = require('./lib/survey');
const analysis = require('./lib/analysis');

// ---------- tiny .env loader (so we don't need the "dotenv" package) ----------
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value; // real env vars win
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const INSTRUCTOR_KEY = process.env.INSTRUCTOR_KEY || 'change-me';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'data.json');

if (INSTRUCTOR_KEY === 'change-me') {
  console.warn('WARNING: INSTRUCTOR_KEY is not set. Set it in your environment before using this in class.');
}

// ---------- poll storage (disk) ----------
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { rounds: [] };
  }
}
function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let data = loadData();

const currentRound = () => (data.rounds.length ? data.rounds[data.rounds.length - 1] : null);

function tally(round) {
  const counts = {};
  for (const opt of round.options) counts[opt] = 0;
  for (const code in round.votes) {
    const choice = round.votes[code].choice;
    if (counts[choice] !== undefined) counts[choice]++;
  }
  return counts;
}

function summarizeHistory() {
  return data.rounds.map((r) => ({
    id: r.id,
    question: r.question,
    isOpen: r.isOpen,
    scale: r.scale || 'custom',
    totalVotes: Object.keys(r.votes).length,
    results: tally(r),
  }));
}

// ---------- survey storage (MEMORY ONLY) ----------
let survey = null;
let surveyVersion = 0;

// Sections shown in the projected class-safe view. Sensitive sections start switched off.
let presentSections = new Set(
  require('./lib/codebook.json').sections.filter((s) => !s.sensitive).map((s) => s.id)
);

// ---------- http helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  // Pages may only load scripts/styles from this server and may only talk to this server, so no
  // survey or poll data can be sent to a third party from the browser even by accident.
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJsonBody(req, limit) {
  limit = limit || 1e6;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function checkKey(query, headers) {
  const key = headers['x-instructor-key'] || query.get('key');
  return !!key && crypto.timingSafeEqual(digest(key), digest(INSTRUCTOR_KEY));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

// Student codes: exactly the last 4 digits of the student ID. Short entries are zero-padded
// ("123" -> "0123"). Anything else is rejected so names or full IDs are never stored.
function cleanVoteCode(raw) {
  const t = String(raw == null ? '' : raw).trim();
  return /^\d{1,4}$/.test(t) ? t.padStart(4, '0') : null;
}

// Import a previously exported poll CSV (round_id, round_question, student_code, choice, timestamp).
function importPolls(csvText) {
  const rows = parseCSV(csvText).filter((r) => r.some((c) => c !== ''));
  const head = (rows[0] || []).map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const [iId, iQ, iCode, iChoice, iTs] = ['round_id', 'round_question', 'student_code', 'choice', 'timestamp'].map(col);
  if ([iId, iQ, iCode, iChoice].some((i) => i < 0)) {
    throw new UploadError('This is not a poll export: expected columns round_id, round_question, student_code, choice.');
  }
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const id = r[iId];
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, { id, question: r[iQ], votes: [] });
    groups.get(id).votes.push({ code: r[iCode], choice: r[iChoice], ts: iTs >= 0 ? r[iTs] : null });
  }
  const existing = new Set(data.rounds.map((r) => r.id));
  const likertLower = new Map(analysis.LIKERT.map((l) => [l.toLowerCase(), l]));
  let imported = 0;
  let skipped = 0;
  let custom = 0;
  for (const g of groups.values()) {
    if (existing.has(g.id)) {
      skipped++;
      continue;
    }
    const isLikert = g.votes.every((v) => likertLower.has(String(v.choice).trim().toLowerCase()));
    const times = g.votes.map((v) => v.ts).filter(Boolean).sort();
    const round = {
      id: g.id,
      question: g.question,
      options: isLikert ? analysis.LIKERT.slice() : [...new Set(g.votes.map((v) => v.choice))],
      scale: isLikert ? 'likert5' : 'custom',
      isOpen: false,
      createdAt: times[0] || new Date().toISOString(),
      closedAt: times[times.length - 1] || new Date().toISOString(),
      votes: {},
    };
    if (!isLikert) custom++;
    for (const v of g.votes) {
      const code = cleanVoteCode(v.code);
      if (!code) continue;
      round.votes[code] = { choice: isLikert ? likertLower.get(String(v.choice).trim().toLowerCase()) : v.choice, ts: v.ts || round.createdAt };
    }
    data.rounds.push(round);
    imported++;
  }
  data.rounds.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  saveData(data);
  return { imported, skipped, custom };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const { pathname, searchParams: query } = url;
  const method = req.method;

  try {
    // ---- public: current poll state ----
    if (method === 'GET' && pathname === '/api/state') {
      const round = currentRound();
      if (!round) return sendJson(res, 200, { round: null });
      const code = cleanVoteCode(query.get('code'));
      const yourVote = code && round.votes[code] ? round.votes[code].choice : null;
      const base = { id: round.id, question: round.question, options: round.options, isOpen: round.isOpen, yourVote };
      if (!round.isOpen) {
        base.results = tally(round);
        base.totalVotes = Object.keys(round.votes).length;
      }
      return sendJson(res, 200, { round: base });
    }

    // ---- public: submit or change a vote ----
    if (method === 'POST' && pathname === '/api/vote') {
      const round = currentRound();
      if (!round) return sendJson(res, 400, { error: 'No active poll yet.' });
      if (!round.isOpen) return sendJson(res, 409, { error: 'This poll is closed.' });
      const body = await readJsonBody(req);
      const code = cleanVoteCode(body.code);
      const choice = String(body.choice || '').trim();
      if (!code) return sendJson(res, 400, { error: 'Enter exactly the last 4 digits of your student ID (numbers only).' });
      if (!round.options.includes(choice)) return sendJson(res, 400, { error: 'Invalid option.' });
      round.votes[code] = { choice, ts: new Date().toISOString() };
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // ---- instructor: everything below requires the key ----
    if (pathname.startsWith('/api/admin/')) {
      if (!checkKey(query, req.headers)) return sendJson(res, 401, { error: 'Invalid or missing instructor key' });

      if (method === 'GET' && pathname === '/api/admin/state') {
        const round = currentRound();
        const history = summarizeHistory();
        if (!round) return sendJson(res, 200, { round: null, history });
        return sendJson(res, 200, {
          round: {
            id: round.id, question: round.question, options: round.options, isOpen: round.isOpen,
            totalVotes: Object.keys(round.votes).length, results: tally(round),
          },
          history,
        });
      }

      if (method === 'POST' && pathname === '/api/admin/round') {
        const body = await readJsonBody(req);
        const question = String(body.question || '').trim();
        if (!question) return sendJson(res, 400, { error: 'Enter the statement students will agree or disagree with.' });
        const prev = currentRound();
        if (prev && prev.isOpen) {
          prev.isOpen = false; // starting a new question closes the previous one
          prev.closedAt = new Date().toISOString();
        }
        const round = {
          id: 'r_' + crypto.randomBytes(4).toString('hex'),
          question,
          options: analysis.LIKERT.slice(),
          scale: 'likert5',
          isOpen: true,
          createdAt: new Date().toISOString(),
          votes: {},
        };
        data.rounds.push(round);
        saveData(data);
        return sendJson(res, 200, { ok: true, round: { id: round.id, question, options: round.options } });
      }

      if (method === 'POST' && (pathname === '/api/admin/close' || pathname === '/api/admin/reopen')) {
        const round = currentRound();
        if (!round) return sendJson(res, 400, { error: 'No active poll.' });
        if (pathname.endsWith('close')) {
          round.isOpen = false;
          round.closedAt = new Date().toISOString();
        } else {
          round.isOpen = true;
          delete round.closedAt;
        }
        saveData(data);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'GET' && pathname === '/api/admin/export') {
        const rows = [['round_id', 'round_question', 'student_code', 'choice', 'timestamp']];
        for (const round of data.rounds) {
          for (const code in round.votes) rows.push([round.id, round.question, code, round.votes[code].choice, round.votes[code].ts]);
        }
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="poll_results.csv"',
          'Cache-Control': 'no-store',
        });
        return res.end(toCSV(rows));
      }

      if (method === 'POST' && pathname === '/api/admin/import-polls') {
        const body = await readJsonBody(req, 8e6);
        try {
          return sendJson(res, 200, { ok: true, ...importPolls(String(body.csv || '')) });
        } catch (e) {
          if (e instanceof UploadError) return sendJson(res, 400, { error: e.message });
          throw e;
        }
      }

      // ---- survey data: memory only ----
      if (method === 'POST' && pathname === '/api/admin/survey') {
        const body = await readJsonBody(req, 15e6);
        try {
          const parsed = parseSurveyExport(String(body.csv || ''), { idColumn: body.idColumn || undefined, filename: body.filename });
          parsed.version = ++surveyVersion;
          survey = parsed;
          return sendJson(res, 200, { ok: true, survey: analysis.surveySummary(survey) });
        } catch (e) {
          if (e instanceof UploadError) return sendJson(res, 400, { error: e.message, needsIdColumn: !!e.needsIdColumn, headers: e.headers || null });
          throw e;
        }
      }
      if (method === 'GET' && pathname === '/api/admin/survey') {
        return sendJson(res, 200, { loaded: !!survey, survey: analysis.surveySummary(survey) });
      }
      if (method === 'POST' && pathname === '/api/admin/survey/clear') {
        survey = null;
        surveyVersion++;
        return sendJson(res, 200, { ok: true });
      }

      // ---- analysis ----
      if (method === 'GET' && pathname === '/api/admin/analysis') {
        const model = analysis.getModel(survey, data.rounds, query.get('includeOpen') === '1');
        return sendJson(res, 200, analysis.toClient(model, survey));
      }
      if (method === 'GET' && pathname === '/api/admin/detail') {
        const model = analysis.getModel(survey, data.rounds, query.get('includeOpen') === '1');
        const d = analysis.detail(model, query.get('poll'), query.get('row'));
        return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Unknown poll or variable.' });
      }

      // ---- class-safe (projectable) view ----
      if (method === 'GET' && pathname === '/api/admin/present-config') {
        const secs = analysis.sectionList().filter((s) => s.id !== 'polls');
        return sendJson(res, 200, { sections: secs.map((s) => ({ ...s, included: presentSections.has(s.id) })) });
      }
      if (method === 'POST' && pathname === '/api/admin/present-config') {
        const body = await readJsonBody(req);
        const valid = new Set(analysis.sectionList().map((s) => s.id));
        presentSections = new Set((body.sections || []).filter((id) => valid.has(id)));
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/api/admin/present') {
        const model = analysis.getModel(survey, data.rounds, false);
        const list = model.polls.map((p) => ({ id: p.id, label: p.label, question: p.question }));
        if (!list.length) {
          return sendJson(res, 200, { ready: false, reason: 'No closed poll with enough responses yet.', polls: [] });
        }
        const pollId = query.get('poll') || list[list.length - 1].id;
        const shown = analysis.present(model, pollId, presentSections, 30, survey);
        if (!shown) return sendJson(res, 404, { error: 'Unknown poll.' });
        return sendJson(res, 200, { ...shown, ready: true, surveyLoaded: !!survey, includedSections: [...presentSections] });
      }

      return sendJson(res, 404, { error: 'Not found' });
    }

    // ---- everything else: static files ----
    if (method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    if (err && err.status) return sendJson(res, err.status, { error: err.message });
    console.error(err.message); // never log request bodies: they may contain student data
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Live poll server running at http://localhost:${PORT}`);
  console.log(`Student view:    http://localhost:${PORT}/`);
  console.log(`Instructor view: http://localhost:${PORT}/instructor.html`);
});
