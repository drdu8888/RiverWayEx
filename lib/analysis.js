'use strict';
// Correlates each 5-point Likert poll with every survey variable and with every other poll.
//
// Statistic: Spearman rank correlation (rho), pairwise-complete. rho > 0 means students who scored
// HIGHER on the survey variable also tended to agree MORE with the poll statement.
// P-values come from a permutation test; q-values are Benjamini-Hochberg adjusted within each poll.
// The heat map shows every correlation regardless of significance. q and p are provided only so
// the page can flag which ones are unlikely to be chance.
//
// The class-safe view (present(), bottom of file) does NOT use any of that. It answers one plain question:
// "were students in group A more likely than students in group B to AGREE (Agree / Strongly agree)?"

const codebook = require('./codebook.json');
const { spearman, bhQ, hashStr, chanceTail, mulberry32 } = require('./stats');
const { normCode } = require('./survey');

const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];
const LIKERT_LEVELS = LIKERT.map((label, i) => ({ label, value: i + 1 }));

const MIN_N = 8; // fewest matched students for which a correlation is reported
const MIN_GROUP = 3; // smallest yes/no group worth correlating (instructor view)
const CHANCE_THRESHOLDS = [0.3, 0.4, 0.5, 0.6];
const CLASS_MIN_GROUP = 5; // smallest group ever shown in the class-safe view

const isLikertRound = (r) => r.scale === 'likert5';

function pollMap(round) {
  const m = new Map();
  for (const code in round.votes) {
    const idx = LIKERT.indexOf(round.votes[code].choice);
    if (idx >= 0) m.set(normCode(code), idx + 1);
  }
  return m;
}

function fingerprint(round) {
  let h = 0;
  let n = 0;
  for (const code in round.votes) {
    h = (h + hashStr(code + '=' + round.votes[code].choice)) >>> 0;
    n++;
  }
  return `${round.id}:${n}:${h}`;
}

// ---------- rows (the things a poll is correlated with) ----------
function pushBinary(rows, v, key, label, get, yes, no, item) {
  let ones = 0;
  for (const x of get.values()) ones += x;
  const zeros = get.size - ones;
  if (ones < MIN_GROUP || zeros < MIN_GROUP) return;
  rows.push({ key, label, section: v.section, kind: 'binary', tag: v.tag, question: v.question, type: v.type, item, get, yesLabel: yes, noLabel: no });
}

function buildSurveyRows(survey) {
  const rows = [];
  if (!survey) return rows;
  for (const v of codebook.variables) {
    const vals = survey.values.get(v.key);
    if (!vals || vals.size < MIN_N) continue;
    if (v.kind === 'ordinal') {
      if (new Set(vals.values()).size < 2) continue;
      rows.push({
        key: v.key, label: v.label, section: v.section, kind: 'ordinal', tag: v.tag, question: v.question, type: v.type,
        item: v.item || null, get: vals,
        levels: v.levels.filter((l) => l.value != null).sort((a, b) => a.value - b.value),
      });
    } else if (v.kind === 'multi') {
      pushBinary(rows, v, v.key, v.label, vals, 'Selected', 'Not selected', v.item);
    } else {
      for (const L of v.levels) {
        const g = new Map();
        for (const [code, idx] of vals) g.set(code, idx === L.index ? 1 : 0);
        pushBinary(rows, v, `${v.key}#${L.index}`, v.prefix + L.label, g, L.label, 'Not: ' + L.label, L.label);
      }
    }
  }
  return rows;
}

function pairs(pollMapObj, row) {
  const out = [];
  for (const [code, pv] of pollMapObj) {
    const rv = row.get.get(code);
    if (rv === undefined || rv === null) continue;
    out.push([pv, rv]);
  }
  return out;
}

function pairStat(pollMapObj, row, seed) {
  const x = [];
  const y = [];
  for (const [pv, rv] of pairs(pollMapObj, row)) {
    x.push(pv);
    y.push(rv);
  }
  if (x.length < MIN_N) return { n: x.length, rho: null, p: null };
  const s = spearman(x, y, { seed });
  return s || { n: x.length, rho: null, p: null };
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const sig3 = (x) => (x == null ? null : Number(x.toPrecision(3)));

// ---------- model ----------
let cache = { key: null, model: null };

// rounds: the server's poll rounds, oldest first. Only 5-point Likert rounds are analyzed.
function getModel(survey, rounds, includeOpen) {
  const numbered = rounds.filter(isLikertRound).map((round, i) => ({ round, label: 'P' + (i + 1) }));
  const chosen = numbered.filter((x) => includeOpen || !x.round.isOpen);
  const key = [survey ? survey.version : 'none', includeOpen ? 'o' : 'c', ...chosen.map((x) => x.label + fingerprint(x.round))].join('|');
  if (cache.key === key) return cache.model;

  const all = chosen.map(({ round, label }) => ({
    id: round.id, label, question: round.question, isOpen: !!round.isOpen, map: pollMap(round),
  }));
  const polls = all.filter((p) => p.map.size >= MIN_N);
  const skipped = all.filter((p) => p.map.size < MIN_N).map((p) => ({ id: p.id, label: p.label, votes: p.map.size }));

  const surveyRows = buildSurveyRows(survey);
  const pollRows = polls.map((p) => ({
    key: 'poll:' + p.id, label: `${p.label}: ${p.question}`, section: 'polls', kind: 'ordinal',
    type: 'poll', question: p.question, item: p.label, get: p.map, pollId: p.id, levels: LIKERT_LEVELS,
  }));
  const rows = surveyRows.concat(pollRows);

  const cells = {};
  for (const r of rows) cells[r.key] = {};
  const pairCache = new Map();
  const testsPerPoll = {};
  const chance = {};
  const noiseCeiling = {};

  for (const p of polls) {
    const list = [];
    for (const r of rows) {
      if (r.pollId === p.id) continue;
      let st;
      if (r.pollId) {
        const k = [r.pollId, p.id].sort().join('|');
        st = pairCache.get(k);
        if (!st) {
          st = pairStat(p.map, r, hashStr(k));
          pairCache.set(k, st);
        }
      } else {
        st = pairStat(p.map, r, hashStr(r.key + '|' + p.id));
      }
      list.push({ r, st });
    }
    const q = bhQ(list.map((x) => x.st.p));
    testsPerPoll[p.id] = q.filter((v) => v != null).length;
    list.forEach((x, i) => {
      cells[x.r.key][p.id] = [r3(x.st.rho), x.st.n, sig3(x.st.p), sig3(q[i])];
    });
    // Chance check: how many correlations this large would turn up if NOTHING were related.
    const tested = list.filter((x) => x.st.rho != null);
    // Smallest |rho| at which fewer than one chance correlation is expected in this poll's whole column.
    let ceiling = 0.99;
    for (let t = 0.05; t < 0.99; t += 0.01) {
      if (tested.reduce((s, x) => s + chanceTail(t, x.st.n), 0) < 1) {
        ceiling = Math.round(t * 100) / 100;
        break;
      }
    }
    noiseCeiling[p.id] = ceiling;
    chance[p.id] = CHANCE_THRESHOLDS.map((t) => ({
      t,
      observed: tested.filter((x) => Math.abs(x.st.rho) >= t).length,
      expected: Math.round(tested.reduce((s, x) => s + chanceTail(t, x.st.n), 0) * 10) / 10,
    }));
  }

  const model = { polls, skipped, rows, cells, testsPerPoll, chance, noiseCeiling };
  cache = { key, model };
  return model;
}

// ---------- instructor view ----------
function surveySummary(survey) {
  if (!survey) return null;
  return {
    filename: survey.filename, loadedAt: survey.loadedAt, idColumn: survey.idColumn, mode: survey.mode,
    rowsInFile: survey.rowsInFile, rowsUsed: survey.rowsUsed, skippedTest: survey.skippedTest, noCode: survey.noCode,
    ambiguousCodes: [...survey.ambiguous].sort(), missingColumns: survey.missingColumns, unparsed: survey.unparsed,
    columnsFound: survey.columnsFound, columnsExpected: survey.columnsExpected,
  };
}

function toClient(model, survey) {
  return {
    survey: surveySummary(survey),
    polls: model.polls.map((p) => {
      let matched = 0;
      let ambiguous = 0;
      const unmatched = [];
      if (survey) {
        for (const code of p.map.keys()) {
          if (survey.codes.has(code)) matched++;
          else if (survey.ambiguous.has(code)) ambiguous++;
          else unmatched.push(code);
        }
      }
      return {
        id: p.id, label: p.label, question: p.question, isOpen: p.isOpen,
        votes: p.map.size, matched, ambiguous, unmatched: unmatched.sort(),
        tests: model.testsPerPoll[p.id] || 0,
        chance: model.chance[p.id] || [],
        noiseCeiling: model.noiseCeiling[p.id] || null,
      };
    }),
    skipped: model.skipped,
    sections: sectionList(),
    rows: model.rows.map((r) => ({ key: r.key, label: r.label, section: r.section, kind: r.kind, tag: r.tag || null })),
    cells: model.cells,
  };
}

function sectionList() {
  return codebook.sections
    .map((s) => ({ id: s.id, label: s.label, sensitive: s.sensitive }))
    .concat([{ id: 'polls', label: 'Other polls', sensitive: false }]);
}

function tally(label, scores) {
  const dist = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const s of scores) {
    dist[s - 1]++;
    sum += s;
  }
  return { label, n: scores.length, dist, mean: scores.length ? Math.round((sum / scores.length) * 100) / 100 : null };
}

function detailGroups(row, prs) {
  if (row.kind === 'binary') {
    const no = [];
    const yes = [];
    for (const [pv, rv] of prs) (rv === 1 ? yes : no).push(pv);
    return [tally(row.noLabel, no), tally(row.yesLabel, yes)];
  }
  const by = new Map();
  for (const [pv, rv] of prs) {
    if (!by.has(rv)) by.set(rv, []);
    by.get(rv).push(pv);
  }
  return row.levels.filter((l) => by.has(l.value)).map((l) => tally(l.label, by.get(l.value)));
}

// How the poll answers are distributed within each answer level of one survey variable.
function detail(model, pollId, rowKey) {
  const poll = model.polls.find((p) => p.id === pollId);
  const row = model.rows.find((r) => r.key === rowKey);
  if (!poll || !row) return null;
  const cell = (model.cells[rowKey] || {})[pollId] || [null, 0, null, null];
  return {
    poll: { id: poll.id, label: poll.label, question: poll.question },
    row: { key: row.key, label: row.label, section: row.section, kind: row.kind },
    cell: { rho: cell[0], n: cell[1], p: cell[2], q: cell[3] },
    groups: detailGroups(row, pairs(poll.map, row)),
    scale: LIKERT,
  };
}

// ---------- class-safe view ----------
// Everything below turns the survey into plain comparisons that can be projected:
//   "Of students who answered A, 78% agreed with this statement; of students who answered B, 31% did."
// Cards are ranked by how much a gap stands out given the group sizes, and each is tagged beyondLuck = it beats the
// largest result that shuffled (meaningless) data produces 9 times in 10 across all the comparisons on offer.
// A variable appears only if BOTH of its groups have at least CLASS_MIN_GROUP students. Only group sizes and
// group percentages are returned: no student codes, no individual answers.
const MIN_GAP = 0.2; // smallest difference (20 percentage points) worth putting on screen
const MAX_CONNECTIONS = 30;
const LUCK_SHUFFLES = 500;

function joinLabels(levels) {
  if (levels.length === 1) return levels[0].label;
  if (levels.length === 2) return `${levels[0].label} or ${levels[1].label}`;
  return `${levels[0].label} to ${levels[levels.length - 1].label}`;
}

// Splits students into two groups by their survey answer, each at least `min` students, or null (suppressed).
// Binary rows: no / yes. Ordered rows: the most balanced cut-point that leaves both sides big enough.
// rvs: the survey values of the students who answered this poll and have a value for this row.
function rowSplit(row, rvs, min) {
  if (row.kind === 'binary') {
    let yes = 0;
    for (const v of rvs) yes += v === 1 ? 1 : 0;
    if (yes < min || rvs.length - yes < min) return null;
    return { t: null, labels: [row.noLabel, row.yesLabel], yes: [false, true] };
  }
  const vals = [...new Set(rvs)].sort((a, b) => a - b);
  let best = null;
  for (let k = 0; k < vals.length - 1; k++) {
    const t = vals[k];
    let lo = 0;
    for (const v of rvs) if (v <= t) lo++;
    const hi = rvs.length - lo;
    if (lo >= min && hi >= min) {
      const imb = Math.abs(lo - hi);
      if (!best || imb < best.imb) best = { t, imb };
    }
  }
  if (!best) return null;
  return {
    t: best.t,
    labels: [joinLabels(row.levels.filter((l) => l.value <= best.t)), joinLabels(row.levels.filter((l) => l.value > best.t))],
    yes: [null, null],
  };
}

const sideOf = (split, v) => (split.t == null ? (v === 1 ? 1 : 0) : v <= split.t ? 0 : 1);
// How much a gap stands out, given how big the two groups are (a gap between 8 students and 6 students is
// shakier than the same gap between 80 and 60). Used only to rank the cards and to draw the "luck" line; the
// screen shows plain percentages. Pooled with +1/+2 so a group with 0% or 100% still has some spread.
function standout(a0, n0, a1, n1) {
  const pooled = (a0 + a1 + 1) / (n0 + n1 + 2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n0 + 1 / n1));
  return Math.abs(a1 / n1 - a0 / n0) / se;
}

// How much does pure luck produce here? Shuffle who said what in the poll (the survey groups stay fixed),
// record the most striking result among ALL the comparisons on offer, repeat, and take the 90th percentile of
// those maxima. A card is "bigger than luck usually makes" only if it beats that line.
function luckThreshold(items, ag, seed) {
  if (!items.length || ag.length < 2) return Infinity;
  const V = ag.length;
  const perm = Int32Array.from({ length: V }, (_, i) => i);
  const rng = mulberry32(seed);
  const maxima = [];
  for (let b = 0; b < LUCK_SHUFFLES; b++) {
    for (let i = V - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    let best = 0;
    for (const it of items) {
      let a0 = 0;
      let a1 = 0;
      for (let k = 0; k < it.m.length; k++) {
        if (ag[perm[it.m[k]]]) {
          if (it.s[k]) a1++;
          else a0++;
        }
      }
      const z = standout(a0, it.n0, a1, it.n1);
      if (z > best) best = z;
    }
    maxima.push(best);
  }
  maxima.sort((x, y) => x - y);
  return maxima[Math.floor(0.9 * (maxima.length - 1))];
}

const presentCache = new WeakMap();

// One side of a comparison: how many of its n students disagreed / were neutral / agreed with the poll statement.
function presentGroup(label, yes, n, agree, disagree) {
  return { label, yes, n, agree, disagree, neutral: n - agree - disagree, pct: Math.round((agree / n) * 100) };
}

// What may be projected. Returns plain comparisons ("connections"), strongest first, one per survey question
// before any question repeats, so the first screens cover different topics.
function present(model, pollId, includeSections, topN, survey) {
  const poll = model.polls.find((p) => p.id === pollId);
  if (!poll) return null;
  const limit = topN || MAX_CONNECTIONS;
  const ckey = [pollId, [...includeSections].sort().join(','), limit, survey ? survey.version : 'none'].join('|');
  let perModel = presentCache.get(model);
  if (!perModel) presentCache.set(model, (perModel = new Map()));
  if (perModel.has(ckey)) return perModel.get(ckey);

  const counts = [0, 0, 0, 0, 0];
  for (const v of poll.map.values()) counts[v - 1]++;
  const codes = [...poll.map.keys()];
  const ag = codes.map((c) => (poll.map.get(c) >= 4 ? 1 : 0)); // 1 = Agree or Strongly agree
  const dis = codes.map((c) => (poll.map.get(c) <= 2 ? 1 : 0)); // 1 = Disagree or Strongly disagree

  const candidates = model.rows.filter((r) => (r.pollId ? r.pollId !== pollId : includeSections.has(r.section)));
  const evald = [];
  let hidden = 0;
  for (const r of candidates) {
    const m = [];
    const rv = [];
    codes.forEach((c, i) => {
      const v = r.get.get(c);
      if (v !== undefined && v !== null) {
        m.push(i);
        rv.push(v);
      }
    });
    if (m.length < MIN_N) continue;
    const split = rowSplit(r, rv, CLASS_MIN_GROUP);
    if (!split) {
      hidden++;
      continue;
    }
    const s = Uint8Array.from(rv.map((v) => sideOf(split, v)));
    let n0 = 0, n1 = 0, a0 = 0, a1 = 0, d0 = 0, d1 = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k]) {
        n1++;
        a1 += ag[m[k]];
        d1 += dis[m[k]];
      } else {
        n0++;
        a0 += ag[m[k]];
        d0 += dis[m[k]];
      }
    }
    evald.push({ r, split, m: Int32Array.from(m), s, n0, n1, a0, a1, d0, d1, score: standout(a0, n0, a1, n1), gap: Math.abs(a1 / n1 - a0 / n0) });
  }

  const luck = luckThreshold(evald, ag, hashStr('luck|' + pollId + '|' + codes.length));
  // In points: the gap two typical-sized groups would need to beat that line (worst case, groups near 50%).
  let luckGap = null;
  if (evald.length && Number.isFinite(luck)) {
    const need = evald.map((e) => luck * Math.sqrt(0.25 * (1 / e.n0 + 1 / e.n1))).sort((x, y) => x - y);
    luckGap = Math.min(100, Math.round(need[Math.floor(need.length / 2)] * 100));
  }
  const ranked = evald
    .filter((e) => e.gap >= MIN_GAP - 1e-9)
    .sort((x, y) => y.score - x.score || (x.r.key < y.r.key ? -1 : 1));

  // pass 1: strongest connection per survey question; pass 2: the rest. Mirror images (the Yes row and the
  // No row of a two-answer question) are skipped.
  const pick = [];
  const takenTags = new Set();
  const sigs = new Map();
  const tagOf = (e) => e.r.tag || e.r.pollId || e.r.key;
  const sigOf = (e) => [`${e.n0}:${e.a0}`, `${e.n1}:${e.a1}`].sort().join('/');
  for (const pass of [1, 2]) {
    for (const e of ranked) {
      if (pick.length >= limit) break;
      if (pick.includes(e)) continue;
      const tag = tagOf(e);
      if (pass === 1 && takenTags.has(tag)) continue;
      if (pass === 2 && (sigs.get(tag) || new Set()).has(sigOf(e))) continue;
      pick.push(e);
      takenTags.add(tag);
      if (!sigs.has(tag)) sigs.set(tag, new Set());
      sigs.get(tag).add(sigOf(e));
    }
  }

  const connections = pick.map((e) => {
    const g = [
      presentGroup(e.split.labels[0], e.split.yes[0], e.n0, e.a0, e.d0),
      presentGroup(e.split.labels[1], e.split.yes[1], e.n1, e.a1, e.d1),
    ];
    const hi = g[1].agree / g[1].n > g[0].agree / g[0].n ? 1 : 0;
    return {
      key: e.r.key, section: e.r.section, type: e.r.type || 'single', question: e.r.question || null, item: e.r.item || null,
      more: g[hi], less: g[1 - hi], gap: Math.round(e.gap * 100), beyondLuck: e.score > luck,
    };
  });

  let matched = 0;
  if (survey) for (const c of poll.map.keys()) if (survey.codes.has(c)) matched++;

  const out = {
    poll: { id: poll.id, label: poll.label, question: poll.question },
    polls: model.polls.map((p) => ({ id: p.id, label: p.label, question: p.question })),
    histogram: { counts, total: poll.map.size },
    connections,
    compared: evald.length,
    luckGap,
    matched,
    hidden,
    minGroup: CLASS_MIN_GROUP,
    minGap: Math.round(MIN_GAP * 100),
    scale: LIKERT,
  };
  perModel.set(ckey, out);
  return out;
}

module.exports = {
  LIKERT, LIKERT_LEVELS, MIN_N, CLASS_MIN_GROUP, isLikertRound,
  getModel, toClient, detail, present, surveySummary, sectionList,
};
