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
  assert.equal(R.classCaution({ chance: [], matched: 10 }), null);
  assert.equal(R.classCaution({ chance: near.level && [{ t: 0.3, observed: 48, expected: 34.7 }], matched: 24, tests: 234, noiseCeiling: 0.55 }).level, 'warn');
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
