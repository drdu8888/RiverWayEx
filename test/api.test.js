// End-to-end API test. Run with:  node --test test/api.test.js
// Starts the real server on a throwaway port with a throwaway data folder.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3100 + Math.floor(Math.random() * 400);
const KEY = 'test-key';
const BASE = `http://127.0.0.1:${PORT}`;
const sample = (f) => fs.readFileSync(path.join(ROOT, 'sample-data', f), 'utf8');
// Poll labels (P1, P2, ...) depend on how many rounds came before, so tests look polls up by wording.
const Q = {
  ai: 'Generative AI tools help students think more deeply.',
  regulate: 'Governments should regulate the development of AI.',
  religion: 'Religion belongs in public life.',
  alone: 'I learn best when I study alone.',
  teach: 'Colleges should teach everyone how to use AI responsibly.',
};
const pollBy = (a, q) => {
  const p = a.polls.find((x) => x.question === q);
  assert.ok(p, `poll "${q}" should be in the analysis`);
  return p;
};

let child;
let dataDir;

async function api(method, p, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers['x-instructor-key'] = key || KEY;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livepoll-test-'));
  child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, INSTRUCTOR_KEY: KEY, DATA_DIR: dataDir } });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('running') && resolve());
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
});

after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('admin endpoints reject a missing or wrong key', async () => {
  assert.equal((await api('GET', '/api/admin/state', undefined, null)).status, 401);
  assert.equal((await api('GET', '/api/admin/analysis', undefined, 'wrong')).status, 401);
  assert.equal((await api('GET', '/api/admin/present', undefined, null)).status, 401);
  assert.equal((await api('POST', '/api/admin/survey', { csv: 'x' }, null)).status, 401);
});

test('polls are 5-point Likert; votes need exactly 4 digits; starting a poll closes the previous one', async () => {
  const a = await api('POST', '/api/admin/round', { question: 'First statement' });
  assert.deepEqual(a.json.round.options, ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']);
  assert.equal((await api('POST', '/api/vote', { code: 'Jane', choice: 'Agree' }, null)).status, 400);
  assert.equal((await api('POST', '/api/vote', { code: '12345678', choice: 'Agree' }, null)).status, 400);
  assert.equal((await api('POST', '/api/vote', { code: '4821', choice: 'Maybe' }, null)).status, 400);
  assert.equal((await api('POST', '/api/vote', { code: '457', choice: 'Agree' }, null)).status, 200); // padded
  const mine = await api('GET', '/api/state?code=0457', undefined, null);
  assert.equal(mine.json.round.yourVote, 'Agree');
  await api('POST', '/api/admin/round', { question: 'Second statement' });
  const h = (await api('GET', '/api/admin/state')).json.history;
  assert.equal(h[0].isOpen, false, 'first poll should have been closed automatically');
  assert.equal(h[1].isOpen, true);
  await api('POST', '/api/admin/close');
});

test('import the sample poll history; poll-to-poll analysis works with no survey loaded', async () => {
  const r = await api('POST', '/api/admin/import-polls', { csv: sample('SAMPLE_poll_export_FAKE.csv') });
  assert.equal(r.json.imported, 6);
  const again = await api('POST', '/api/admin/import-polls', { csv: sample('SAMPLE_poll_export_FAKE.csv') });
  assert.equal(again.json.imported, 0, 'importing twice must not duplicate rounds');
  assert.equal(again.json.skipped, 6);
  const a = (await api('GET', '/api/admin/analysis')).json;
  assert.equal(a.survey, null);
  assert.equal(a.polls.length, 6, 'the two throwaway rounds have too few votes and are skipped');
  assert.ok(a.rows.every((row) => row.section === 'polls'));
});

test('rejects a file that is not the survey, and asks which column holds the last-4 digits', async () => {
  const wrong = await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_poll_export_FAKE.csv') });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /does not look like/);
  const noId = sample('SAMPLE_survey_export_FAKE.csv').replace(/StudentLast4/g, 'Mystery');
  const need = await api('POST', '/api/admin/survey', { csv: noId });
  assert.equal(need.status, 400);
  assert.equal(need.json.needsIdColumn, true);
  assert.ok(need.json.headers.includes('Mystery'));
  assert.ok(!need.json.headers.includes('POL3'), 'question columns are not offered as ID candidates');
  const ok = await api('POST', '/api/admin/survey', { csv: noId, idColumn: 'Mystery' });
  assert.equal(ok.status, 200);
});

let textModel;
test('survey upload (choice-text export) parses fully', async () => {
  const up = await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE.csv'), filename: 'x.csv' });
  assert.equal(up.status, 200);
  const s = up.json.survey;
  assert.equal(s.mode, 'text');
  assert.equal(s.idColumn, 'StudentLast4');
  assert.equal(s.rowsUsed, 28);
  assert.equal(s.columnsFound, s.columnsExpected);
  assert.deepEqual(s.missingColumns, []);
  assert.deepEqual(s.unparsed, {}, 'every answer should map to a known choice');
  assert.deepEqual(s.ambiguousCodes, []);
  textModel = (await api('GET', '/api/admin/analysis')).json;
});

test('the numeric export (with Excel-stripped leading zeros) gives identical results', async () => {
  const up = await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE_numeric.csv') });
  assert.equal(up.json.survey.mode, 'numeric');
  assert.deepEqual(up.json.survey.unparsed, {});
  const numModel = (await api('GET', '/api/admin/analysis')).json;
  assert.deepEqual(numModel.cells, textModel.cells);
  assert.equal(numModel.polls[0].matched, textModel.polls[0].matched);
});

test('analysis output is internally consistent (n = 28 is too small to assert planted effects; see power.test.js)', async () => {
  const a = textModel;
  const ai = pollBy(a, Q.ai).id;
  const teach = pollBy(a, Q.teach).id;
  let cellsSeen = 0;
  for (const rowKey in a.cells) {
    for (const pid in a.cells[rowKey]) {
      const [rho, n, p, q] = a.cells[rowKey][pid];
      cellsSeen++;
      if (rho == null) continue;
      assert.ok(rho >= -1 && rho <= 1, `${rowKey}: rho out of range`);
      assert.ok(n >= 8 && n <= 28, `${rowKey}: n=${n}`);
      assert.ok(p > 0 && p <= 1 && q >= p - 1e-9 && q <= 1, `${rowKey}: p=${p}, q=${q}`);
    }
  }
  assert.ok(cellsSeen > 1000, `expected >1000 cells, got ${cellsSeen}`);
  // planted rows exist and were computed
  for (const row of ['Q59_1', 'Q55', 'REL3', 'POL3', 'HABITS_FREQ_5']) assert.ok(a.cells[row][ai][0] != null, row);
  // the two AI-attitude polls share a latent factor, so they should at least lean the same way
  assert.ok(a.cells['poll:' + ai][teach][0] > 0, 'AI polls should correlate positively');
  // poll-poll cells are symmetric
  // (rho, n and p match; q is adjusted within each poll's own family of tests, so it can differ)
  assert.deepEqual(a.cells['poll:' + ai][teach].slice(0, 3), a.cells['poll:' + teach][ai].slice(0, 3));
  // chance table: present, expected falls as the threshold rises, observed never rises
  for (const p of a.polls) {
    assert.equal(p.chance.length, 4);
    for (let i = 1; i < 4; i++) {
      assert.ok(p.chance[i].expected <= p.chance[i - 1].expected);
      assert.ok(p.chance[i].observed <= p.chance[i - 1].observed);
    }
    assert.ok(p.chance[0].expected > 0);
  }
});

test('diagnostics: typo code is reported as unmatched; the partial respondent only counts where they answered', async () => {
  const a = (await api('GET', '/api/admin/analysis')).json;
  const p1 = pollBy(a, Q.ai);
  assert.deepEqual(p1.unmatched, ['9999']);
  assert.equal(p1.matched + p1.unmatched.length + p1.ambiguous, p1.votes);
  // student #6 stopped after the Life Experiences section, so has no political answers
  const pol3 = a.cells['POL3'][p1.id];
  assert.ok(pol3[1] < p1.matched, 'POL3 should have fewer pairs than matched voters because of the partial respondent');
});

test('duplicate last-4 codes are excluded, never silently merged', async () => {
  const lines = sample('SAMPLE_survey_export_FAKE.csv').trimEnd().split('\n');
  const dup = [...lines, lines[lines.length - 1]].join('\n'); // repeat the last respondent
  const up = await api('POST', '/api/admin/survey', { csv: dup });
  assert.equal(up.json.survey.ambiguousCodes.length, 1);
  assert.equal(up.json.survey.rowsUsed, 27);
  const a = (await api('GET', '/api/admin/analysis')).json;
  const total = a.polls.reduce((n, p) => n + p.ambiguous, 0);
  assert.ok(total >= 0);
  await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE.csv') }); // restore
});

test('detail view returns per-level poll distributions', async () => {
  const a = (await api('GET', '/api/admin/analysis')).json;
  const p4 = pollBy(a, Q.religion).id;
  const d = (await api('GET', `/api/admin/detail?poll=${p4}&row=${encodeURIComponent('REL3')}`)).json;
  assert.ok(d.groups.length >= 2);
  assert.equal(d.groups.reduce((n, g) => n + g.n, 0), d.cell.n);
  const nominal = (await api('GET', `/api/admin/detail?poll=${p4}&row=${encodeURIComponent('POL1#0')}`)).json;
  assert.equal(nominal.groups.length, 2);
});

const groupsOf = (c) => [c.more, c.less];
const keysDeep = (o, acc = new Set()) => {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, acc));
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { acc.add(k); keysDeep(o[k], acc); }
  return acc;
};

test('class-safe view: groups of 5+, plain percentages, no codes, sensitive sections off by default, toggle works', async () => {
  const p = (await api('GET', '/api/admin/present')).json;
  assert.equal(p.ready, true);
  assert.equal(p.minGroup, 5);
  assert.ok(p.connections.length > 0);
  assert.ok(p.connections.length <= 30);
  for (const c of p.connections) {
    for (const g of groupsOf(c)) {
      assert.ok(g.n >= 5, `${c.key} group "${g.label}" has only ${g.n}`);
      assert.equal(g.agree + g.neutral + g.disagree, g.n, `${c.key}: agree + neutral + disagree must equal the group size`);
      assert.equal(g.pct, Math.round((g.agree / g.n) * 100));
    }
    assert.ok(c.more.pct > c.less.pct, 'the "more likely" group really has the higher share');
    assert.equal(c.gap, Math.round((c.more.agree / c.more.n - c.less.agree / c.less.n) * 100));
    assert.ok(c.gap >= p.minGap, `gap ${c.gap} is below the ${p.minGap}-point floor`);
    assert.ok(['single', 'matrix', 'multi', 'nominal', 'poll'].includes(c.type));
    assert.equal(typeof c.beyondLuck, 'boolean');
    assert.notEqual(c.section, 'political');
    assert.notEqual(c.section, 'religious');
  }
  assert.ok(!/\b\d{4}\b.*student|student_code|"code"/i.test(JSON.stringify(p)), 'no student codes in payload');
  assert.ok(p.hidden >= 0);
  // switch the religious section on: its items may now appear (at n = 28 which poll they show up for is luck)
  const religiousShown = async () => {
    let seen = 0;
    for (const poll of p.polls) {
      const r = (await api('GET', `/api/admin/present?poll=${poll.id}`)).json;
      for (const c of r.connections) for (const g of groupsOf(c)) assert.ok(g.n >= 5);
      seen += r.connections.filter((x) => x.section === 'religious').length;
    }
    return seen;
  };
  assert.equal(await religiousShown(), 0, 'religious items must be absent by default');
  const cfg = (await api('GET', '/api/admin/present-config')).json;
  const ids = cfg.sections.filter((s) => s.included).map((s) => s.id).concat('religious');
  await api('POST', '/api/admin/present-config', { sections: ids });
  assert.ok((await religiousShown()) > 0, 'religious items should appear for at least one poll once enabled');
  await api('POST', '/api/admin/present-config', { sections: ids.filter((s) => s !== 'religious') }); // restore default
  assert.equal(await religiousShown(), 0);
});

test('class-safe view: one card per survey question before any question repeats, no mirror images', async () => {
  const tagOf = (c) => c.key.split('#')[0].replace(/_\d+$/, '');
  for (const poll of (await api('GET', '/api/admin/present')).json.polls) {
    const p = (await api('GET', `/api/admin/present?poll=${poll.id}`)).json;
    const tags = p.connections.map(tagOf);
    // the cards come in two runs: first the strongest card of each question, then second helpings
    const firstRun = tags.findIndex((t, i) => tags.indexOf(t) !== i);
    const run = firstRun === -1 ? tags.length : firstRun;
    assert.equal(new Set(tags.slice(0, run)).size, run, `${poll.label}: first run must be all different questions`);
    assert.ok(run >= Math.min(8, p.connections.length), `${poll.label}: first screens should span several questions (got ${run})`);
    // no card is the exact mirror of another (same question, same two groups, same counts)
    const sig = p.connections.map((c) => tagOf(c) + '|' + groupsOf(c).map((g) => `${g.n}:${g.agree}`).sort().join('/'));
    assert.equal(new Set(sig).size, sig.length, `${poll.label}: mirror-image cards`);
  }
});

test('class-safe payload speaks plainly: no correlations, p-values, or chance tables are sent to the projector page', async () => {
  await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE.csv') });
  const p = (await api('GET', '/api/admin/present')).json;
  const keys = keysDeep(p);
  for (const banned of ['rho', 'cells', 'context', 'chance', 'noiseCeiling', 'tests', 'p', 'q', 'mean', 'dist']) assert.ok(!keys.has(banned), `payload must not carry "${banned}"`);
  assert.deepEqual(Object.keys(p.connections[0]).sort(), ['beyondLuck', 'gap', 'item', 'key', 'less', 'more', 'question', 'section', 'type']);
  assert.deepEqual(Object.keys(p.connections[0].more).sort(), ['agree', 'disagree', 'label', 'n', 'neutral', 'pct', 'yes']);
  assert.ok(p.matched > 0 && p.compared > 100 && p.luckGap > 0 && p.luckGap <= 100);
  assert.ok(p.luckGap >= 40, `at ~25 students luck alone should need a big gap (got ${p.luckGap})`);
});

test('survey data lives in memory only: nothing from the survey is written to disk, and clearing works', async () => {
  const files = fs.readdirSync(dataDir);
  assert.deepEqual(files.sort(), ['data.json']);
  const disk = fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8');
  for (const marker of ['fake1@example.edu', 'R_FAKE0001', 'Fake01', 'POL3', 'Very liberal', 'Christian']) {
    assert.ok(!disk.includes(marker), `data.json must not contain survey content (${marker})`);
  }
  await api('POST', '/api/admin/survey/clear');
  assert.equal((await api('GET', '/api/admin/survey')).json.loaded, false);
  const a = (await api('GET', '/api/admin/analysis')).json;
  assert.equal(a.survey, null);
});

test('analysis is fast enough for live use', async () => {
  await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE.csv') });
  await api('POST', '/api/admin/survey', { csv: sample('SAMPLE_survey_export_FAKE.csv') }); // new version => cache miss
  const t0 = Date.now();
  const a = (await api('GET', '/api/admin/analysis')).json;
  const ms = Date.now() - t0;
  console.log(`      full analysis: ${a.rows.length} variables x ${a.polls.length} polls in ${ms} ms`);
  assert.ok(ms < 15000);
  const t1 = Date.now();
  await api('GET', '/api/admin/analysis');
  assert.ok(Date.now() - t1 < 1500, 'cached second request should be quick');
});

test('every response carries a Content-Security-Policy that blocks outside scripts and outside connections', async () => {
  for (const p of ['/', '/analysis.html', '/api/state']) {
    const res = await fetch(BASE + p);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/, p);
    assert.match(csp, /connect-src 'self'/, p);
    assert.ok(!/unsafe-eval|https?:/.test(csp), `${p}: CSP must not allow eval or outside hosts`);
  }
});
