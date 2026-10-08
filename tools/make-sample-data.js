#!/usr/bin/env node
// Writes FAKE sample files into sample-data/ so you can try the analysis tools without real data.
//   SAMPLE_survey_export_FAKE.csv          Qualtrics export, "Use choice text" style
//   SAMPLE_survey_export_FAKE_numeric.csv  same students, "Use numeric values" style, with the
//                                          leading zeros stripped from the last-4 column (as Excel does)
//   SAMPLE_poll_export_FAKE.csv            what "Export CSV" in the instructor console produces
// Everything is randomly generated from a fixed seed. No real person is represented.
// Some relationships are deliberately planted (see PLANTED below) so you can check that the
// heat map finds them.
//
// Options:  --n 28        number of fake students (default 28, about one seminar section)
//           --out DIR     where to write the files (default: ./sample-data)

const fs = require('fs');
const path = require('path');
const codebook = require('../lib/codebook.json');
const { mulberry32 } = require('../lib/stats');
const { toCSV } = require('../lib/csv');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const N = Math.max(8, parseInt(opt('n', '28'), 10) || 28);
const OUT_DIR = path.resolve(opt('out', path.join(__dirname, '..', 'sample-data')));
const rng = mulberry32(20261006);
const rand = () => rng();
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const Phi = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pickWeighted = (w) => {
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return i;
  return w.length - 1;
};

// ---- students ----
const codes = new Set(['0457']); // guarantee at least one code with a leading zero
while (codes.size < N) codes.add(String(Math.floor(rand() * 10000)).padStart(4, '0'));
const students = [...codes].map((code, i) => ({
  i, code,
  cons: gauss(), rel: gauss(), tech: gauss(), acad: gauss(), soc: gauss(),
}));

// ---- planted relationships for ordinal survey variables: [latent: weight] ----
const SPEC = [
  [/^POL3$/, { cons: 0.85 }],
  [/^POL_AGREE2_1$/, { cons: -0.6 }],
  [/^POL_AGREE2_2$/, { cons: -0.65 }],
  [/^REL(3|4|5|6|7)$/, { rel: 0.85 }],
  [/^REL_AGREE_(1|6)$/, { rel: 0.6 }],
  [/^REL_AGREE_4$/, { rel: 0.4 }],
  [/^VALUES_IMPORTANCE_17$/, { rel: 0.7 }],
  [/^Q55$/, { tech: 0.7 }],
  [/^Q57$/, { tech: 0.7 }],
  [/^Q59_1$/, { tech: 0.75 }],
  [/^Q59_5$/, { tech: 0.7 }],
  [/^Q59_3$/, { tech: 0.5 }],
  [/^Q59_2$/, { tech: -0.5 }],
  [/^Q59_4$/, { tech: -0.35 }],
  [/^Q59_6$/, { tech: -0.4 }],
  [/^Q59_7$/, { tech: 0.3 }],
  [/^Q59_8$/, { tech: -0.3, cons: -0.2 }],
  [/^Q58_/, { tech: 0.5 }],
  [/^(CONFIDENCE|ACAD_SELFRATE|TRAITS_SELFRATE)_/, { acad: 0.6 }],
  [/^HABITS_FREQ_1$/, { acad: 0.4, soc: 0.3 }],
  [/^HABITS_FREQ_2$/, { acad: -0.5 }],
  [/^HABITS_FREQ_5$/, { soc: 0.6 }],
  [/^MEDIA_AGREE_2$/, { acad: 0.4 }],
  [/^MEDIA2$/, { soc: 0.35, tech: 0.2 }],
  [/^LIFE_AGREE_6$/, { soc: 0.6 }],
  [/^EXPECT_CHANCE_(4|5)$/, { soc: 0.55 }],
];

const PLANTED = [
  'Statement 1 (AI helps thinking)  <-  tech: Q55, Q57, Q59_1, Q59_5, Q58_*',
  'Statement 2 (regulate AI)        <-  -tech and -cons: Q59_8, POL_AGREE2_*, POL3',
  'Statement 3 (community service)  <-  soc and -cons: EXPECT_CHANCE_4/5, LIFE_AGREE_6',
  'Statement 4 (religion in public) <-  rel and cons: REL3-REL7, REL_AGREE_6, POL3',
  'Statement 5 (study alone)        <-  -soc: HABITS_FREQ_5, LIFE_AGREE_6',
  'Statement 6 (teach AI use)       <-  tech: shares a factor with statement 1, so those two should correlate',
];

function ordinalValue(v, st) {
  const spec = SPEC.find(([re]) => re.test(v.key));
  const weights = spec ? spec[1] : {};
  let w2 = 0;
  for (const k in weights) w2 += weights[k] * weights[k];
  // signal from the planted latent factors + independent noise, nudged slightly toward agreement
  let z = 0.15 + gauss() * Math.sqrt(Math.max(0.05, 1 - w2));
  for (const k in weights) z += weights[k] * st[k];
  const scored = v.levels.filter((l) => l.value != null);
  const unscored = v.levels.filter((l) => l.value == null);
  if (unscored.length && rand() < 0.06) return unscored[0];
  const val = clamp(Math.floor(Phi(z) * scored.length) + 1, 1, scored.length);
  return scored.find((l) => l.value === val);
}

const NOMINAL_WEIGHTS = {
  FAM1: [0.35, 0.6, 0.05], FAM5: [0.7, 0.15, 0.07, 0.05, 0.03], FAM6: [0.15, 0.25, 0.3, 0.2, 0.1],
  FAM8: [0.85, 0.05, 0.1], LIFE1: [0.2, 0.5, 0.3], LIFE5: [0.8, 0.2], ACAD1: [0.6, 0.1, 0.1, 0.1, 0.05, 0.05],
  POL6: [0.5, 0.2, 0.25, 0.05], POL7: [0.25, 0.45, 0.2, 0.1], REL2: [0.1, 0.3, 0.05, 0.5, 0.05],
  REL8: [0.2, 0.4, 0.3, 0.1],
};

function nominalIndex(v, st) {
  if (v.key === 'POL1') {
    const z = st.cons + 0.5 * gauss();
    if (z > 0.55) return 0; // Republican
    if (z < -0.35) return 1; // Democrat
    return [2, 3, 4][pickWeighted([0.6, 0.2, 0.2])];
  }
  if (v.key === 'REL1') {
    const z = st.rel + 0.4 * gauss();
    if (z > 0.6) return [0, 1, 4, 5][pickWeighted([0.55, 0.3, 0.07, 0.08])];
    if (z > -0.3) return [9, 0, 1, 13][pickWeighted([0.35, 0.25, 0.2, 0.2])];
    return [11, 12, 13][pickWeighted([0.3, 0.3, 0.4])];
  }
  if (v.key === 'Q56') {
    if (st.tech < -0.8 && rand() < 0.6) return 5;
    return pickWeighted([0.5, 0.15, 0.1, 0.08, 0.05, 0.12]);
  }
  const w = NOMINAL_WEIGHTS[v.key];
  return w ? pickWeighted(w) : Math.floor(rand() * v.levels.length);
}

function multiSelected(v) {
  if (v.key === 'MEDIA3_2') return rand() < 0.6;
  if (v.key === 'MEDIA3_8') return rand() < 0.03;
  if (v.key === 'MEDIA1_6') return rand() < 0.12;
  return rand() < 0.3;
}

// ---- generate answers ----
// answers[studentIdx][variableKey] = {label, code}  (or for multi: boolean)
const answers = students.map((st, si) => {
  const a = {};
  const partial = si === 5; // one student stops after the Life Experiences section
  for (const v of codebook.variables) {
    if (partial && !['family', 'life'].includes(v.section)) continue;
    if (v.kind === 'ordinal') {
      const l = ordinalValue(v, st);
      a[v.key] = { label: l.label, code: l.code };
    } else if (v.kind === 'nominal') {
      const l = v.levels[nominalIndex(v, st)];
      a[v.key] = { label: l.label, code: l.code };
    }
  }
  // multi-select questions: blank for everything if the whole question was skipped
  const byTag = {};
  for (const v of codebook.variables) if (v.kind === 'multi') (byTag[v.tag] = byTag[v.tag] || []).push(v);
  for (const tag in byTag) {
    if (partial) continue;
    let any = false;
    const sel = byTag[tag].map((v) => (a[v.key] = multiSelected(v)));
    if (!sel.some(Boolean)) a[byTag[tag][0].key] = true; // answering requires at least one option
  }
  return a;
});

// ---- survey CSV (Qualtrics export layout: 3 header rows) ----
const META = [
  ['StartDate', 'Start Date', 'startDate'], ['EndDate', 'End Date', 'endDate'], ['Status', 'Response Type', 'status'],
  ['IPAddress', 'IP Address', 'ipAddress'], ['Progress', 'Progress', 'progress'],
  ['Duration (in seconds)', 'Duration (in seconds)', 'duration'], ['Finished', 'Finished', 'finished'],
  ['RecordedDate', 'Recorded Date', 'recordedDate'], ['ResponseId', 'Response ID', '_recordId'],
  ['RecipientLastName', 'Recipient Last Name', 'recipientLastName'],
  ['RecipientFirstName', 'Recipient First Name', 'recipientFirstName'],
  ['RecipientEmail', 'Recipient Email', 'recipientEmail'], ['ExternalReference', 'External Data Reference', 'externalDataReference'],
  ['LocationLatitude', 'Location Latitude', 'locationLatitude'], ['LocationLongitude', 'Location Longitude', 'locationLongitude'],
  ['DistributionChannel', 'Distribution Channel', 'distributionChannel'], ['UserLanguage', 'User Language', 'userLanguage'],
];

function surveyCSV(numeric, stripZeros) {
  const header1 = META.map((m) => m[0]).concat(codebook.variables.map((v) => v.column), ['StudentLast4']);
  const header2 = META.map((m) => m[1]).concat(codebook.variables.map((v) => `${v.question} - ${v.label}`), ['StudentLast4']);
  const header3 = META.map((m) => `{"ImportId":"${m[2]}"}`).concat(
    codebook.variables.map((v) => `{"ImportId":"${v.column}"}`), ['{"ImportId":"StudentLast4"}']
  );
  const rows = [header1, header2, header3];
  students.forEach((st, i) => {
    const a = answers[i];
    const partial = i === 5;
    const mm = String(10 + i).padStart(2, '0');
    const meta = [
      `2026-09-01 09:${mm}:00`, `2026-09-01 09:${String(Number(mm) + 14).padStart(2, '0')}:00`,
      numeric ? '0' : 'IP Address', `10.0.0.${i + 10}`, partial ? '38' : '100', String(600 + i * 17),
      partial ? (numeric ? '0' : 'False') : numeric ? '1' : 'True', `2026-09-01 09:${mm}:30`, `R_FAKE${String(i).padStart(4, '0')}`,
      'Student', `Fake${String(i + 1).padStart(2, '0')}`, `fake${i + 1}@example.edu`, '', '', '', 'email', 'EN',
    ];
    const cells = codebook.variables.map((v) => {
      if (v.kind === 'multi') {
        if (!(v.key in a)) return '';
        return a[v.key] ? (numeric ? v.choiceCode : v.choice) : '';
      }
      const x = a[v.key];
      if (!x) return '';
      return numeric ? x.code : x.label;
    });
    const code = stripZeros ? String(Number(st.code)) : st.code;
    rows.push(meta.concat(cells, [code]));
  });
  return toCSV(rows) + '\n';
}

// ---- poll CSV (same layout the instructor console exports) ----
const POLLS = [
  { q: 'Generative AI tools help students think more deeply.', f: { tech: 0.85 } },
  { q: 'Governments should regulate the development of AI.', f: { tech: -0.4, cons: -0.35 } },
  { q: 'Every college student should complete community service.', f: { soc: 0.5, cons: -0.3 } },
  { q: 'Religion belongs in public life.', f: { rel: 0.7, cons: 0.4 } },
  { q: 'I learn best when I study alone.', f: { soc: -0.7 } },
  { q: 'Colleges should teach everyone how to use AI responsibly.', f: { tech: 0.45 } },
];
const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];
const pollRows = [['round_id', 'round_question', 'student_code', 'choice', 'timestamp']];
POLLS.forEach((p, pi) => {
  const id = `r_fake${pi + 1}`;
  const day = new Date(Date.UTC(2026, 8, 22 + pi * 7, 14, 0, 0));
  students.forEach((st, si) => {
    if (rand() > 0.88) return; // absent that day
    let z = 0.1 + gauss() * Math.sqrt(0.55);
    for (const k in p.f) z += p.f[k] * st[k];
    const score = clamp(Math.floor(Phi(z) * 5) + 1, 1, 5);
    const ts = new Date(day.getTime() + si * 9000).toISOString();
    pollRows.push([id, p.q, st.code, LIKERT[score - 1], ts]);
  });
  if (pi === 0) pollRows.push([id, p.q, '9999', 'Agree', new Date(day.getTime() + 600000).toISOString()]); // typo'd code
});

const dir = OUT_DIR;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'SAMPLE_survey_export_FAKE.csv'), surveyCSV(false, false));
fs.writeFileSync(path.join(dir, 'SAMPLE_survey_export_FAKE_numeric.csv'), surveyCSV(true, true));
fs.writeFileSync(path.join(dir, 'SAMPLE_poll_export_FAKE.csv'), toCSV(pollRows) + '\n');
fs.writeFileSync(
  path.join(dir, 'README.txt'),
  'ALL DATA IN THIS FOLDER IS FAKE (randomly generated). It is safe to commit.\n\n' +
    `Generated with ${N} fake students.\n\n` +
    'Planted relationships (so you can check the heat map finds them):\n  ' + PLANTED.join('\n  ') + '\n\n' +
    'Do not expect to see them all in a class of ~28: with ~235 comparisons per statement, real moderate\n' +
    'relationships are usually swamped by chance at that size (that is true of real data too).\n' +
    'Regenerate a bigger fake class to watch them appear:  node tools/make-sample-data.js --n 160 --out /some/folder\n'
);
console.log(`Wrote sample data for ${N} fake students and ${POLLS.length} polls to ${dir}`);
