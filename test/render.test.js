// Unit tests for the browser-side rendering helpers and a static check of the pages.
// Run with:  node --test test/render.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/render.js');

test('colour scale: blue for negative, orange for positive, white-ish at zero, capped at |rho| = .7', () => {
  assert.match(R.color(-0.7).bg, /^rgb\(33,102,172\)$/);
  assert.match(R.color(0.7).bg, /^rgb\(179,88,6\)$/);
  assert.match(R.color(0.9).bg, /^rgb\(179,88,6\)$/);
  assert.match(R.color(0).bg, /^rgb\(247,247,247\)$/);
  assert.equal(R.color(null).bg, null);
});

test('markers follow q first, then raw p', () => {
  assert.equal(R.marker([0.5, 20, 0.001, 0.03]), '**');
  assert.equal(R.marker([0.4, 20, 0.004, 0.08]), '*');
  assert.equal(R.marker([0.4, 20, 0.04, 0.4]), '†');
  assert.equal(R.marker([0.1, 20, 0.5, 0.9]), '');
  assert.equal(R.marker([null, 5, null, null]), '');
});

test('number formatting uses a real minus sign and drops the leading zero', () => {
  assert.equal(R.fmtRho(-0.456), '−.46');
  assert.equal(R.fmtRho(0.5), '+.50');
  assert.equal(R.fmtP(0.00002), '<.0001');
});

const a = {
  sections: [{ id: 'ai', label: 'AI' }, { id: 'polls', label: 'Polls' }],
  polls: [{ id: 'p1', label: 'P1', question: 'Q1' }, { id: 'p2', label: 'P2', question: 'Q2' }],
  rows: [
    { key: 'A', label: 'Alpha', section: 'ai', kind: 'ordinal' },
    { key: 'B', label: 'Beta', section: 'ai', kind: 'ordinal' },
    { key: 'C', label: 'Gamma <script>', section: 'polls', kind: 'ordinal' },
    { key: 'D', label: 'Delta', section: 'ai', kind: 'ordinal' },
  ],
  cells: {
    A: { p1: [0.2, 20, 0.3, 0.8], p2: [-0.6, 20, 0.001, 0.02] },
    B: { p1: [0.5, 20, 0.01, 0.06], p2: [0.1, 20, 0.6, 0.9] },
    C: { p1: [-0.3, 20, 0.2, 0.7] },
    D: { p1: [null, 4, null, null], p2: [null, 4, null, null] },
  },
};

test('selectRows: sorting, filtering and dropping rows with no computable cells', () => {
  const ids = (o) => R.selectRows(a, o).map((x) => x.row.key);
  assert.deepEqual(ids({}), ['A', 'B', 'C']);              // strongest anywhere first; D has nothing computable
  assert.deepEqual(ids({ sortBy: 'p1' }), ['B', 'C', 'A']);
  assert.deepEqual(ids({ sortBy: 'survey' }), ['A', 'B', 'C']);
  assert.deepEqual(ids({ minAbs: 0.55 }), ['A']);
  assert.deepEqual(ids({ onlyQ: true }), ['A', 'B']);
  assert.deepEqual(ids({ onlyQ: true, sortBy: 'p2' }), ['A']);
  assert.deepEqual(ids({ sections: new Set(['polls']) }), ['C']);
  assert.deepEqual(ids({ search: 'bet' }), ['B']);
  assert.deepEqual(ids({ pollIds: ['p1'] }), ['B', 'C', 'A']);
});

test('heat table escapes text and marks cells', () => {
  const html = R.heatTable(a, R.selectRows(a, {}), ['p1', 'p2'], 'p1');
  assert.ok(!html.includes('<script>'), 'row labels must be HTML-escaped');
  assert.ok(html.includes('Gamma &lt;script&gt;'));
  assert.ok(html.includes('<sup>**</sup>'));
  assert.ok(html.includes('data-row="A" data-poll="p2"'));
  assert.equal((html.match(/class="na"/g) || []).length, 1); // C has no p2 cell
});

test('chance verdict: flags excess only when clearly above expectation', () => {
  const near = R.chanceVerdict({ chance: [{ t: 0.3, observed: 48, expected: 34.7 }, { t: 0.5, observed: 5, expected: 2.4 }, { t: 0.6, observed: 2, expected: 0.3 }] });
  assert.equal(near.level, 'near');
  const above = R.chanceVerdict({ chance: [{ t: 0.3, observed: 13, expected: 0.1 }, { t: 0.4, observed: 4, expected: 0 }, { t: 0.5, observed: 4, expected: 0 }, { t: 0.6, observed: 0, expected: 0 }] });
  assert.equal(above.level, 'above');
  assert.match(above.text, /0\.5/);
  assert.equal(R.smallNNote({ matched: 200, tests: 234, noiseCeiling: 0.3 }), '');
  assert.match(R.smallNNote({ matched: 24, tests: 234, noiseCeiling: 0.55 }), /24 matched students.*\.55/);
});

test('plain-language description names the direction and strength', () => {
  const d = (rho, kind, section) => ({
    cell: { rho },
    row: { kind, section: section || 'ai', label: 'Importance of religion' },
    groups: [{ label: 'Not: X' }, { label: 'X' }],
  });
  assert.match(R.describe(d(0.45, 'ordinal')), /higher scores.*agree more.*moderate/);
  assert.match(R.describe(d(-0.6, 'binary')), /“X”.*agree less.*strong/);
  assert.match(R.describe(d(0.03, 'ordinal')), /Essentially no relationship/);
  assert.match(R.describe({ ...d(0.35, 'ordinal', 'polls'), row: { kind: 'ordinal', section: 'polls', label: 'P3: stmt' } }), /agreed more with P3.*also tended/);
});

// ---------- class view: plain-English connections ----------
const grp = (label, n, agree, disagree, yes) => ({ label, yes: yes === undefined ? null : yes, n, agree, disagree, neutral: n - agree - disagree, pct: Math.round((agree / n) * 100) });
const conn = (o) => ({ key: 'K', section: 'academic', type: 'single', question: 'How often do you study?', item: null, gap: 40, beyondLuck: false,
  more: grp('Often or Very Often', 10, 8, 1), less: grp('Never to Sometimes', 12, 4, 5), ...o });

test('summary line: three shares that always add to 100', () => {
  assert.equal(R.agreeSummaryText([2, 3, 5, 8, 7]), '60% agreed · 20% neutral · 20% disagreed');
  const s = R.agreeSummary([1, 1, 1, 0, 0]);
  assert.equal(s.agree + s.neutral + s.disagree, 100);
  assert.equal(R.agreeSummary([0, 0, 0, 0, 0]), null);
  assert.equal(R.agreeSummaryText([0, 0, 0, 0, 0]), '');
});

test('degree words follow the size of the gap', () => {
  assert.equal(R.degreeWord(20), 'somewhat more likely');
  assert.equal(R.degreeWord(29), 'somewhat more likely');
  assert.equal(R.degreeWord(30), 'more likely');
  assert.equal(R.degreeWord(49), 'more likely');
  assert.equal(R.degreeWord(50), 'much more likely');
});

test('sentences read as "students who answered X were more likely to agree than students who answered Y"', () => {
  const plain = (h) => h.replace(/<[^>]+>/g, '');
  assert.equal(
    plain(R.connectionSentenceHtml(conn({}))),
    'Students who answered “Often or Very Often” were more likely to agree with this statement than students who answered “Never to Sometimes” (80% agreed vs. 33%). They were also less likely to disagree (10% vs. 42%).'
  );
  // yes/no: a single answer chosen from a list
  const nominal = conn({ type: 'nominal', item: 'Rural area', question: 'I grew up primarily in a', more: grp('Rural area', 9, 7, 0, true), less: grp('Not: Rural area', 14, 4, 6, false), gap: 55 });
  assert.equal(plain(R.connectionSentenceHtml(nominal)), 'Students who answered “Rural area” were much more likely to agree with this statement than students who answered something else (78% agreed vs. 29%). They were also less likely to disagree (0% vs. 43%).');
  // the comparison group can be the one that is MORE likely
  const flipped = { ...nominal, more: nominal.less, less: nominal.more };
  assert.equal(plain(R.connectionSentenceHtml(flipped)), 'Students who answered something other than “Rural area” were much more likely to agree with this statement than students who answered “Rural area” (29% agreed vs. 78%).');
  // select-all questions
  const multi = conn({ type: 'multi', item: 'Reddit', more: grp('Selected', 9, 7, 1, true), less: grp('Not selected', 17, 5, 8, false), gap: 25 });
  assert.equal(plain(R.connectionSentenceHtml(multi)), 'Students who selected “Reddit” were somewhat more likely to agree with this statement than students who did not (78% agreed vs. 29%). They were also less likely to disagree (11% vs. 47%).');
  assert.match(plain(R.connectionSentenceHtml({ ...multi, more: multi.less, less: multi.more })), /^Students who did not select “Reddit” were .* than students who did \(29% agreed vs\. 78%\)\.$/);
  // an earlier class statement
  const poll = conn({ type: 'poll', item: 'P2', question: 'Religion belongs in public life.', more: grp('Agree or Strongly agree', 8, 6, 1), less: grp('Strongly disagree to Neutral', 15, 4, 6) });
  assert.equal(plain(R.connectionSentenceHtml(poll)), 'Students who answered “Agree or Strongly agree” on P2 were more likely to agree with this statement than students who answered “Strongly disagree to Neutral” (75% agreed vs. 27%). They were also less likely to disagree (13% vs. 40%).');
});

test('each card names its source question and shows both groups with what they said', () => {
  const html = R.connectionHtml(conn({ type: 'matrix', question: 'In the past year, how often did you do each of the following?', item: 'Felt bored in class' }));
  assert.match(html, /On the survey/);
  assert.match(html, /In the past year, how often did you do each of the following\?/);
  assert.match(html, /Felt bored in class/);
  assert.match(html, /80% <small>agreed<\/small>/);
  assert.match(html, /33% <small>agreed<\/small>/);
  assert.match(html, /1 disagreed · 1 neutral · 8 agreed/);
  assert.match(html, /5 disagreed · 3 neutral · 4 agreed/);
  assert.match(html, /Answered “Often or Very Often” <small>\(10 students\)/);
  // every card carries its own colour legend, in words, right above the bars
  assert.match(html, /Each bar shows how that group voted.*Disagreed or strongly disagreed.*Neutral.*Agreed or strongly agreed.*cb-pair/);
  // wide segments are labelled with the word, not just a number
  assert.match(html, />42% disagreed</);
  assert.match(html, />25% neutral</);
  assert.match(html, />80% agreed</);
  assert.match(html, /title="10% neutral \(1 of 10\)"/);
  assert.equal((html.match(/class="seg /g) || []).length, 6); // 3 segments x 2 groups, none empty here
  assert.match(R.connectionHtml(conn({ type: 'poll', item: 'P2', question: 'Religion belongs in public life.' })), /Earlier class statement \(P2\)/);
  assert.match(R.connectionHtml(conn({ type: 'multi', item: 'Reddit', question: 'Which platform do you use often?', more: grp('Selected', 9, 7, 1, true), less: grp('Not selected', 17, 5, 8, false) })), /choose all that apply/);
});

test('class cards use no statistics vocabulary and carry a plain coincidence note', () => {
  const all = [conn({}), conn({ beyondLuck: true }), conn({ type: 'nominal', item: 'X', more: grp('X', 5, 4, 0, true), less: grp('Not: X', 20, 5, 10, false) })]
    .map(R.connectionHtml).join(' ') + R.readingGuideHtml({ minGroup: 5, luckGap: 58 }) + R.readingGuideHtml({ minGroup: 5, luckGap: 100 }) + R.connectionKeyHtml() + R.agreeSummaryText([2, 3, 5, 8, 7]);
  const text = all.replace(/<[^>]+>/g, ' ');
  assert.ok(!/\b(p-value|p =|rho|ρ|correlat|significan|q <|Spearman|regression|standard deviation|confidence interval)/i.test(text), 'no jargon: ' + text.match(/\b(p-value|p =|rho|ρ|correlat|significan|q <|Spearman)[^ ]*/i));
  assert.match(R.connectionHtml(conn({})), /Could be a coincidence/);
  assert.match(R.connectionHtml(conn({ beyondLuck: true })), /Bigger than luck usually makes/);
  assert.match(R.readingGuideHtml({ minGroup: 5, luckGap: 58 }), /differ by roughly 58 points/);
  assert.match(R.readingGuideHtml({ minGroup: 5, luckGap: 58 }), /groups of 5 or more students/);
  assert.match(R.readingGuideHtml({ minGroup: 5, luckGap: 100 }), /even a very large gap can be a coincidence/);
  assert.ok(!/points/.test(R.readingGuideHtml({ minGroup: 5, luckGap: null })));
});

test('survey wording is escaped in the class view', () => {
  const html = R.connectionHtml(conn({ type: 'matrix', question: 'Q <img src=x onerror=alert(1)>', item: 'I <script>alert(1)</script> agree', more: grp('A <b>', 6, 5, 0), less: grp('B"', 7, 1, 4) }));
  assert.ok(!/<img|<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('pages: no inline scripts, no external URLs (the privacy claim on the Analysis page)', () => {
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f.endsWith('.html')) {
      const scripts = [...text.matchAll(/<script\b([^>]*)>/g)];
      assert.ok(scripts.length > 0, f);
      for (const m of scripts) assert.match(m[1], /src="\/[\w.-]+\.js"/, `${f}: inline or external script`);
    }
    // no http(s) URLs in anything shipped to the browser except plain-text mentions in comments/strings
    const urls = text.match(/(?:src|href)\s*=\s*["']https?:\/\//g);
    assert.equal(urls, null, `${f} references an external resource`);
    assert.ok(!/\bfetch\(\s*['"`]https?:/.test(text), `${f} calls an external URL`);
  }
});
