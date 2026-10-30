#!/usr/bin/env node
// Builds lib/codebook.json from a Qualtrics .qsf survey file.
// The QSF holds only the questions (no student responses), so it is safe to keep around.
//
// Usage:  node tools/build-codebook.js path/to/survey.qsf
// Re-run it whenever you change the survey (new semester, new questions).

const fs = require('fs');
const path = require('path');

const qsfPath = process.argv[2];
if (!qsfPath) {
  console.error('Usage: node tools/build-codebook.js path/to/survey.qsf');
  process.exit(1);
}
const qsf = JSON.parse(fs.readFileSync(qsfPath, 'utf8'));
const els = qsf.SurveyElements;

// ---------- sections ----------
// sensitive=true sections are left OFF by default in the class-safe (projected) view.
const SECTIONS = [
  { id: 'family', label: 'Family & Personal Background', sensitive: false },
  { id: 'life', label: 'Life Experiences & Values', sensitive: false },
  { id: 'academic', label: 'Academic Background, Motivation & Confidence', sensitive: false },
  { id: 'ai', label: 'Generative AI Use & Attitudes', sensitive: false },
  { id: 'media', label: 'Media & Information Habits', sensitive: false },
  { id: 'political', label: 'Political Views & Civic Engagement', sensitive: true },
  { id: 'religious', label: 'Religious & Spiritual Background', sensitive: true },
];

function sectionForBlock(desc) {
  const d = desc.toLowerCase();
  if (d.startsWith('family')) return 'family';
  if (d.startsWith('life')) return 'life';
  if (d.startsWith('academic')) return 'academic';
  if (d.startsWith('media')) return 'media';
  if (d.startsWith('political')) return 'political';
  if (d.startsWith('religious')) return 'religious';
  return null; // introduction etc.
}

// The AI questions sit at the end of the Academic block in Qualtrics; give them their own section.
const AI_TAGS = new Set(['Q55', 'Q56', 'Q57', 'Q58', 'Q59']);

// ---------- hand annotations ----------
// Single-select questions that have a natural order. reverse=true means the options are listed
// from "most" to "least", so we flip them so that a HIGHER score always means MORE.
const ORDINAL_SINGLES = {
  FAM2: { label: 'Parents’ education level' },
  FAM3: { label: 'Number of older siblings' },
  FAM4: { label: 'Number of younger siblings' },
  FAM7: { label: 'Family moves during K-12' },
  LIFE2: { label: 'Travel outside home state/region' },
  LIFE3: { label: 'Travel outside home country' },
  LIFE4: { label: 'Volunteer/community service experience' },
  POL3: { label: 'Political views (higher = more conservative)' },
  POL4: { label: 'Political views similar to parents (higher = closer)', reverse: true },
  POL5: { label: 'Interest in politics and government' },
  REL3: { label: 'Importance of religion (higher = more important)', reverse: true },
  REL4: { label: 'Centrality of religion in life (higher = more central)', reverse: true },
  REL5: { label: 'Religious service attendance (higher = more often)', reverse: true },
  REL6: { label: 'Devotional/spiritual practice (higher = more often)', reverse: true },
  REL7: { label: 'Certainty of belief in God/higher power (higher = more certain)', reverse: true },
  MEDIA2: { label: 'Checks social media multiple times per day' },
  MEDIA7: { label: 'Feels informed about current events' },
  Q55: { label: 'Uses generative AI for schoolwork (frequency)' },
  Q57: { label: 'Self-rated generative AI skill' },
};

// Labels for single-select questions with no natural order: each option becomes its own yes/no indicator.
const NOMINAL_PREFIX = {
  FAM1: 'First in family to attend a 4-year college: ',
  FAM5: 'Household type: ',
  FAM6: 'Grew up in: ',
  FAM8: 'English spoken at home: ',
  LIFE1: 'Job before college: ',
  LIFE5: 'First time living away from home: ',
  ACAD1: 'High school type: ',
  POL1: 'Party ID: ',
  POL6: 'Registered to vote: ',
  POL7: 'Political environment growing up: ',
  REL1: 'Religious identity: ',
  REL2: 'Religious change since childhood: ',
  REL8: 'Religious environment growing up: ',
  Q56: 'Generative AI tool used: ',
};

const MULTI_PREFIX = {
  MEDIA1: 'News source: ',
  MEDIA3: 'Uses platform: ',
  MEDIA4: 'Entertainment via: ',
  MEDIA5: 'Music genre: ',
  MEDIA6: 'TV/movie genre: ',
};

const MATRIX_PREFIX = {
  VALUES_IMPORTANCE: 'Importance to me: ',
  ACAD_SELFRATE: 'Self-rated vs peers: ',
  ACAD_FREQ: 'Past year: ',
  COLLEGE_REASONS: 'Reason for college: ',
  CONFIDENCE: 'Confident I can: ',
  HABITS_FREQ: 'HS habit: ',
  TRAITS_SELFRATE: 'Self-rated trait: ',
  EXPECT_CHANCE: 'Chance I will: ',
  TIME_USE: 'Weekly time: ',
  POL_FREQ: 'Past year: ',
  Q58: 'AI OK for: ',
};

// Answer labels that mean "no usable position on the scale" (treated as missing, not as a score).
const MISSING_LABELS = new Set(['not sure']);

// ---------- helpers ----------
const clean = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*\((select all that apply|mark the highest that applies)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

function orderedChoices(q) {
  const ids = (q.ChoiceOrder && q.ChoiceOrder.length ? q.ChoiceOrder : Object.keys(q.Choices)).map(String);
  return ids.map((id) => ({ id, label: clean(q.Choices[id].Display) }));
}

function orderedAnswers(q) {
  const ids = (q.AnswerOrder && q.AnswerOrder.length ? q.AnswerOrder : Object.keys(q.Answers)).map(String);
  return ids.map((id) => ({ id, label: clean(q.Answers[id].Display) }));
}

// ---------- map questions to sections in survey order ----------
const blockEl = els.find((e) => e.Element === 'BL');
const blocks = Array.isArray(blockEl.Payload) ? blockEl.Payload : Object.values(blockEl.Payload);
const qById = {};
for (const e of els) if (e.Element === 'SQ') qById[e.Payload.QuestionID || e.PrimaryAttribute] = e.Payload;

const ordered = []; // {q, section}
for (const b of blocks) {
  if (b.Type === 'Trash') continue;
  const sec = sectionForBlock(b.Description || '');
  for (const be of b.BlockElements || []) {
    if (be.Type !== 'Question') continue;
    const q = qById[be.QuestionID];
    if (!q || q.QuestionType === 'DB') continue;
    ordered.push({ q, section: AI_TAGS.has(q.DataExportTag) ? 'ai' : sec });
  }
}

// ---------- build variables ----------
const variables = [];
for (const { q, section } of ordered) {
  const tag = q.DataExportTag;
  const text = clean(q.QuestionText);

  if (q.QuestionType === 'MC' && q.Selector === 'MAVR') {
    const prefix = MULTI_PREFIX[tag] || text + ': ';
    for (const c of orderedChoices(q)) {
      variables.push({
        key: `${tag}_${c.id}`, kind: 'multi', section, tag,
        column: `${tag}_${c.id}`, label: prefix + c.label, question: text,
        type: 'multi', item: c.label, choice: c.label, choiceCode: c.id,
      });
    }
  } else if (q.QuestionType === 'MC') {
    const choices = orderedChoices(q);
    if (ORDINAL_SINGLES[tag]) {
      const { label, reverse } = ORDINAL_SINGLES[tag];
      const scored = reverse ? choices.slice().reverse() : choices;
      const valueOf = {};
      scored.forEach((c, i) => (valueOf[c.id] = i + 1));
      variables.push({
        key: tag, kind: 'ordinal', section, tag, column: tag, label, question: text, type: 'single', item: null,
        levels: choices.map((c) => ({ code: c.id, label: c.label, value: valueOf[c.id] })),
      });
    } else {
      variables.push({
        key: tag, kind: 'nominal', section, tag, column: tag,
        label: (NOMINAL_PREFIX[tag] || text + ': ').replace(/: $/, ''), prefix: NOMINAL_PREFIX[tag] || text + ': ',
        question: text, type: 'nominal', item: null,
        levels: choices.map((c, i) => ({ code: c.id, label: c.label, index: i })),
      });
    }
  } else if (q.QuestionType === 'Matrix') {
    const answers = orderedAnswers(q);
    const prefix = MATRIX_PREFIX[tag] || '';
    // Positions run in listed order (low -> high); "Not sure"-type answers become missing.
    let pos = 0;
    const levels = answers.map((a) => {
      if (MISSING_LABELS.has(a.label.toLowerCase())) return { code: a.id, label: a.label, value: null };
      pos += 1;
      return { code: a.id, label: a.label, value: pos };
    });
    for (const c of orderedChoices(q)) {
      variables.push({
        key: `${tag}_${c.id}`, kind: 'ordinal', section, tag,
        column: `${tag}_${c.id}`, label: prefix + c.label, question: text, type: 'matrix', item: c.label, levels,
      });
    }
  }
}

const used = new Set(variables.map((v) => v.section));
const out = {
  generatedFrom: path.basename(qsfPath),
  surveyName: qsf.SurveyEntry.SurveyName,
  sections: SECTIONS.filter((s) => used.has(s.id)),
  variables,
};
const dest = path.join(__dirname, '..', 'lib', 'codebook.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1));

const byKind = variables.reduce((m, v) => ((m[v.kind] = (m[v.kind] || 0) + 1), m), {});
console.log(`Wrote ${dest}`);
console.log(`${variables.length} survey columns:`, byKind);
