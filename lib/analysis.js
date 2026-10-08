'use strict';
// Correlates each 5-point Likert poll with every survey variable and with every other poll.
//
// Statistic: Spearman rank correlation (rho), pairwise-complete. rho > 0 means students who scored
// HIGHER on the survey variable also tended to agree MORE with the poll statement.
// P-values come from a permutation test; q-values are Benjamini-Hochberg adjusted within each poll.
// The heat map shows every correlation regardless of significance. q and p are provided only so
// the page can flag which ones are unlikely to be chance.

const codebook = require('./codebook.json');
const { spearman, bhQ, hashStr, chanceTail } = require('./stats');
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
function pushBinary(rows, v, key, label, get, yes, no) {
  let ones = 0;
  for (const x of get.values()) ones += x;
  const zeros = get.size - ones;
  if (ones < MIN_GROUP || zeros < MIN_GROUP) return;
  rows.push({ key, label, section: v.section, kind: 'binary', tag: v.tag, question: v.question, get, yesLabel: yes, noLabel: no });
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
        key: v.key, label: v.label, section: v.section, kind: 'ordinal', tag: v.tag, question: v.question, get: vals,
        levels: v.levels.filter((l) => l.value != null).sort((a, b) => a.value - b.value),
      });
    } else if (v.kind === 'multi') {
      pushBinary(rows, v, v.key, v.label, vals, 'Selected', 'Not selected');
    } else {
      for (const L of v.levels) {
        const g = new Map();
        for (const [code, idx] of vals) g.set(code, idx === L.index ? 1 : 0);
        pushBinary(rows, v, `${v.key}#${L.index}`, v.prefix + L.label, g, L.label, 'Not: ' + L.label);
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
    get: p.map, pollId: p.id, levels: LIKERT_LEVELS,
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
function joinLabels(levels) {
  return levels.length === 1 ? levels[0].label : `${levels[0].label} – ${levels[levels.length - 1].label}`;
}

// Two groups, each at least `min` students, or null (suppressed).
function classGroups(row, prs, min) {
  if (row.kind === 'binary') {
    const g = detailGroups(row, prs);
    return g[0].n >= min && g[1].n >= min ? g : null;
  }
  const vals = [...new Set(prs.map((p) => p[1]))].sort((a, b) => a - b);
  let best = null;
  for (let k = 0; k < vals.length - 1; k++) {
    const t = vals[k];
    let lo = 0;
    for (const p of prs) if (p[1] <= t) lo++;
    const hi = prs.length - lo;
    if (lo >= min && hi >= min) {
      const imb = Math.abs(lo - hi);
      if (!best || imb < best.imb) best = { t, imb };
    }
  }
  if (!best) return null;
  const lowLevels = row.levels.filter((l) => l.value <= best.t);
  const highLevels = row.levels.filter((l) => l.value > best.t);
  return [
    tally(joinLabels(lowLevels), prs.filter((p) => p[1] <= best.t).map((p) => p[0])),
    tally(joinLabels(highLevels), prs.filter((p) => p[1] > best.t).map((p) => p[0])),
  ];
}

// What may be projected: class-level patterns only. A variable appears only if BOTH of its groups
// have at least 5 students; no codes or individual answers are ever returned.
function present(model, pollId, includeSections, topN, survey) {
  const poll = model.polls.find((p) => p.id === pollId);
  if (!poll) return null;
  const counts = [0, 0, 0, 0, 0];
  for (const v of poll.map.values()) counts[v - 1]++;

  const candidates = model.rows.filter((r) => (r.pollId ? r.pollId !== pollId : includeSections.has(r.section)));
  const keep = [];
  let hidden = 0;
  for (const r of candidates) {
    const c = model.cells[r.key][pollId];
    if (!c || c[0] == null) continue;
    const groups = classGroups(r, pairs(poll.map, r), CLASS_MIN_GROUP);
    if (!groups) {
      hidden++;
      continue;
    }
    keep.push({ r, rho: c[0], n: c[1], groups });
  }
  keep.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

  const rows = keep.slice(0, topN || 20).map(({ r, rho, n, groups }) => {
    const cells = {};
    for (const p2 of model.polls) {
      if (p2.id === r.pollId) continue;
      if (p2.id === pollId) {
        cells[p2.id] = [rho, n];
        continue;
      }
      const c2 = model.cells[r.key][p2.id];
      cells[p2.id] =
        c2 && c2[0] != null && classGroups(r, pairs(p2.map, r), CLASS_MIN_GROUP) ? [c2[0], c2[1]] : null;
    }
    return { key: r.key, label: r.label, section: r.section, cells, groups };
  });

  let matched = 0;
  if (survey) for (const c of poll.map.keys()) if (survey.codes.has(c)) matched++;

  return {
    poll: { id: poll.id, label: poll.label, question: poll.question },
    polls: model.polls.map((p) => ({ id: p.id, label: p.label, question: p.question })),
    histogram: { counts, total: poll.map.size },
    // class-level context only (counts of students and of comparisons, never who)
    context: {
      matched, tests: model.testsPerPoll[pollId] || 0, noiseCeiling: model.noiseCeiling[pollId] || null,
      chance: model.chance[pollId] || [],
    },
    rows,
    hidden,
    minGroup: CLASS_MIN_GROUP,
    scale: LIKERT,
  };
}

module.exports = {
  LIKERT, LIKERT_LEVELS, MIN_N, CLASS_MIN_GROUP, isLikertRound,
  getModel, toClient, detail, present, surveySummary, sectionList,
};
