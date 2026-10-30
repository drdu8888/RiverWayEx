// Statistical behaviour test.  Run with:  node --test test/power.test.js
//
// Two questions, answered with a larger FAKE class (160 students):
//   1. POWER   - when relationships really exist, does the tool find them (and rank them near the top)?
//   2. NULL    - when a poll is pure noise, does the tool stay quiet?
// (With a real seminar of ~25 students, power is far lower; see the README for what that means.)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCSV, toCSV } = require('../lib/csv');
const { mulberry32 } = require('../lib/stats');

const ROOT = path.join(__dirname, '..');
const PORT = 3600 + Math.floor(Math.random() * 300);
const KEY = 'power-key';
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let sampleDir;

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-instructor-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livepoll-power-'));
  sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livepoll-sample-'));
  execFileSync('node', ['tools/make-sample-data.js', '--n', '160', '--out', sampleDir], { cwd: ROOT, stdio: 'ignore' });
  child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, INSTRUCTOR_KEY: KEY, DATA_DIR: dataDir } });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('running') && resolve());
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
  const read = (f) => fs.readFileSync(path.join(sampleDir, f), 'utf8');
  assert.equal((await api('POST', '/api/admin/import-polls', { csv: read('SAMPLE_poll_export_FAKE.csv') })).status, 200);
  assert.equal((await api('POST', '/api/admin/survey', { csv: read('SAMPLE_survey_export_FAKE.csv') })).status, 200);
});

after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sampleDir, { recursive: true, force: true });
});

const Q = {
  ai: 'Generative AI tools help students think more deeply.',
  regulate: 'Governments should regulate the development of AI.',
  community: 'Every college student should complete community service.',
  religion: 'Religion belongs in public life.',
  alone: 'I learn best when I study alone.',
  teach: 'Colleges should teach everyone how to use AI responsibly.',
};

test('POWER: planted relationships are found, with the right sign and corrected q-values', async () => {
  const a = (await api('GET', '/api/admin/analysis')).json;
  const id = (q) => a.polls.find((p) => p.question === q).id;
  const cell = (row, q) => a.cells[row][id(q)]; // [rho, n, p, q]
  const expect = [
    // row, poll, sign, min |rho|, max q
    ['Q59_1', Q.ai, +1, 0.35, 0.01],
    ['Q55', Q.ai, +1, 0.35, 0.01],
    ['Q57', Q.ai, +1, 0.35, 0.01],
    ['REL3', Q.religion, +1, 0.3, 0.01],
    ['REL5', Q.religion, +1, 0.3, 0.01],
    ['REL7', Q.religion, +1, 0.3, 0.01],
    ['HABITS_FREQ_5', Q.alone, -1, 0.25, 0.05],
    ['LIFE_AGREE_6', Q.community, +1, 0.25, 0.05],
    ['POL3', Q.religion, +1, 0.2, 0.05],
    ['poll:' + id(Q.ai), Q.teach, +1, 0.3, 0.01],
  ];
  for (const [row, q, sign, minRho, maxQ] of expect) {
    const c = cell(row, q);
    assert.ok(c && c[0] != null, `${row} x "${q}" should be computed`);
    assert.equal(Math.sign(c[0]), sign, `${row} x "${q}": rho=${c[0]}`);
    assert.ok(Math.abs(c[0]) >= minRho, `${row} x "${q}": |rho|=${Math.abs(c[0])} < ${minRho}`);
    assert.ok(c[3] <= maxQ, `${row} x "${q}": q=${c[3]} > ${maxQ}`);
  }
});

test('POWER: the chance-check table shows far more strong correlations than luck would give', async () => {
  const a = (await api('GET', '/api/admin/analysis')).json;
  for (const q of [Q.ai, Q.religion]) {
    const p = a.polls.find((x) => x.question === q);
    const at = (t) => p.chance.find((c) => c.t === t);
    assert.ok(at(0.3).observed >= 5, `${q}: only ${at(0.3).observed} correlations at |rho| >= .3`);
    assert.ok(at(0.3).observed > 10 * Math.max(at(0.3).expected, 0.1));
  }
});

test('POWER: the planted relationships rank among the strongest in the poll\'s column', async () => {
  const a = (await api('GET', '/api/admin/analysis')).json;
  const p = a.polls.find((x) => x.question === Q.religion);
  const ranked = a.rows
    .map((r) => ({ key: r.key, rho: a.cells[r.key][p.id] && a.cells[r.key][p.id][0] }))
    .filter((x) => x.rho != null)
    .sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho))
    .slice(0, 12)
    .map((x) => x.key);
  const relHits = ranked.filter((k) => /^REL/.test(k)).length;
  assert.ok(relHits >= 4, `expected several religion items in the top 12, got ${relHits}: ${ranked.join(', ')}`);
});

test('POWER: the class-safe view surfaces the religious items once that section is switched on', async () => {
  const cfg = (await api('GET', '/api/admin/present-config')).json;
  const base = cfg.sections.filter((s) => s.included).map((s) => s.id);
  const poll = (await api('GET', '/api/admin/present')).json.polls.find((p) => p.question === Q.religion).id;
  const off = (await api('GET', `/api/admin/present?poll=${poll}`)).json;
  assert.ok(!off.connections.some((c) => c.section === 'religious'));
  await api('POST', '/api/admin/present-config', { sections: base.concat('religious') });
  const on = (await api('GET', `/api/admin/present?poll=${poll}`)).json;
  const rel = on.connections.filter((c) => c.section === 'religious');
  assert.ok(rel.length >= 3);
  for (const c of on.connections) for (const g of [c.more, c.less]) assert.ok(g.n >= 5);
  // the planted effects are big at n = 160: the strongest religious cards must clear the "luck" line
  assert.ok(rel.slice(0, 3).every((c) => c.beyondLuck && c.gap >= 30), JSON.stringify(rel.slice(0, 3).map((c) => [c.key, c.gap, c.beyondLuck])));
  await api('POST', '/api/admin/present-config', { sections: base });
});

test('NULL: polls answered at random produce no false alarms', async () => {
  // Same 160 students, but answers drawn at random, independent of everything in the survey.
  const survey = parseCSV(fs.readFileSync(path.join(sampleDir, 'SAMPLE_survey_export_FAKE.csv'), 'utf8'));
  const codeCol = survey[0].indexOf('StudentLast4');
  const codes = survey.slice(3).map((r) => r[codeCol]);
  const rng = mulberry32(777);
  const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];
  const out = [['round_id', 'round_question', 'student_code', 'choice', 'timestamp']];
  const NULLS = ['NULL-A random statement', 'NULL-B random statement', 'NULL-C random statement', 'NULL-D random statement'];
  NULLS.forEach((q, i) => {
    for (const c of codes) if (rng() < 0.9) out.push([`r_null${i}`, q, c, LIKERT[Math.floor(rng() * 5)], new Date(Date.UTC(2026, 10, 1 + i)).toISOString()]);
  });
  assert.equal((await api('POST', '/api/admin/import-polls', { csv: toCSV(out) + '\n' })).json.imported, 4);
  const a = (await api('GET', '/api/admin/analysis')).json;
  let strong = 0;
  let fdr = 0;
  for (const q of NULLS) {
    const p = a.polls.find((x) => x.question === q);
    assert.ok(p, q);
    // no variable should survive the FDR correction against a coin-flip poll...
    for (const r of a.rows) {
      if (r.key === 'poll:' + p.id) continue;
      const c = a.cells[r.key][p.id];
      // ...except the other null polls, which are also noise
      if (c && c[3] != null && c[3] < 0.1) fdr++;
      if (c && c[0] != null && Math.abs(c[0]) >= 0.3) strong++;
    }
    const at = (t) => p.chance.find((c) => c.t === t);
    assert.ok(at(0.3).observed <= 3, `${q}: ${at(0.3).observed} correlations >= .3 from pure noise`);
    assert.ok(at(0.3).expected < 0.5, 'chance table should expect almost none at n ~ 145');
  }
  assert.ok(fdr <= 1, `${fdr} false discoveries at q < .10 across four noise polls (expected ~0)`);
  assert.ok(strong <= 4, `${strong} correlations >= .3 across four noise polls`);
});
