'use strict';
// Turns a Qualtrics "Download Data Table" CSV export into numeric values keyed by student code.
// Handles both export styles ("Use choice text" and "Use numeric values"), the 2-3 header rows
// Qualtrics adds, preview/test rows, and duplicate codes. Nothing here touches disk.

const { parseCSV } = require('./csv');
const codebook = require('./codebook.json');

class UploadError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'UploadError';
    Object.assign(this, extra || {});
  }
}

const normText = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// Student codes are the last 4 digits of a student ID. Excel often drops leading zeros
// ("0457" -> "457"), so short all-digit codes are zero-padded; longer digit strings keep their last 4.
function normCode(s) {
  const t = String(s == null ? '' : s).trim().toUpperCase();
  if (/^\d{1,4}$/.test(t)) return t.padStart(4, '0');
  if (/^\d{5,}$/.test(t)) return t.slice(-4);
  return t;
}

const compact = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_NAME_HINTS = [
  'last4', 'lastfour', 'last4digits', 'studentidlast4', 'studentlast4', 'last4id',
  'id4', 'studentcode', 'pollcode', 'code', 'studentid', 'sid',
];

function buildLookup(v) {
  const byCode = new Map();
  const byLabel = new Map();
  for (const l of v.levels) {
    byCode.set(String(l.code), l);
    byLabel.set(normText(l.label), l);
  }
  return { byCode, byLabel };
}

function parseSurveyExport(csvText, options) {
  options = options || {};
  const rows = parseCSV(csvText).filter((r) => r.some((c) => c !== ''));
  if (rows.length < 2) throw new UploadError('The file has no data rows.');

  const headers = rows[0].map((h) => h.trim());
  const isImportRow = (r) => !!r && r.some((c) => /^\s*\{\s*"ImportId"/.test(c));
  let start = 1;
  if (isImportRow(rows[2])) start = 3;
  else if (isImportRow(rows[1])) start = 2;

  const colIdx = new Map();
  headers.forEach((h, i) => {
    if (h && !colIdx.has(h)) colIdx.set(h, i);
  });

  // Does this look like the River Way survey at all?
  const knownCols = new Set(codebook.variables.map((v) => v.column));
  const found = [...knownCols].filter((c) => colIdx.has(c));
  if (found.length < knownCols.size * 0.5) {
    throw new UploadError(
      `This does not look like an export of the survey: only ${found.length} of ${knownCols.size} expected question columns were found.`
    );
  }

  // Which column holds the last-4 digits?
  const candidates = headers.filter((h) => h && !knownCols.has(h));
  let idColumn = options.idColumn;
  if (idColumn && !colIdx.has(idColumn)) {
    throw new UploadError(`Column "${idColumn}" was not found in the file.`, { needsIdColumn: true, headers: candidates });
  }
  if (!idColumn) idColumn = headers.find((h) => h && ID_NAME_HINTS.includes(compact(h)));
  if (!idColumn) {
    throw new UploadError('Could not tell which column holds the last-4 digits. Choose it from the list.', {
      needsIdColumn: true,
      headers: candidates,
    });
  }
  const idIdx = colIdx.get(idColumn);
  const statusIdx = colIdx.get('Status');

  // Group data rows by code; skip preview/test rows and rows without a code.
  const byCode = new Map();
  let skippedTest = 0;
  let noCode = 0;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    if (statusIdx !== undefined) {
      const st = (row[statusIdx] || '').trim();
      if (/preview|test|spam/i.test(st) || st === '1' || st === '2' || st === '8') {
        skippedTest++;
        continue;
      }
    }
    const code = normCode(row[idIdx]);
    if (!code) {
      noCode++;
      continue;
    }
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }

  // A code that appears on more than one row could be two students sharing last-4 digits, or one
  // student submitting twice. Either way we cannot tell whose answers are whose, so exclude it.
  const usable = new Map();
  const ambiguous = [];
  for (const [code, rs] of byCode) {
    if (rs.length > 1) ambiguous.push(code);
    else usable.set(code, rs[0]);
  }

  // Detect export style: choice text vs numeric values.
  let digitCells = 0;
  let textCells = 0;
  for (const v of codebook.variables) {
    if (v.kind === 'multi') continue;
    if (v.levels.some((l) => /^\d/.test(l.label))) continue; // labels that are themselves numbers
    const ci = colIdx.get(v.column);
    if (ci === undefined) continue;
    for (const row of usable.values()) {
      const cell = (row[ci] || '').trim();
      if (!cell) continue;
      if (/^\d+$/.test(cell)) digitCells++;
      else textCells++;
    }
  }
  const mode = digitCells > textCells ? 'numeric' : 'text';

  const values = new Map();
  const unparsed = {};
  const missingColumns = [];
  const multiGroups = new Map(); // tag -> [variables]

  for (const v of codebook.variables) {
    const ci = colIdx.get(v.column);
    if (ci === undefined) {
      missingColumns.push(v.column);
      continue;
    }
    if (v.kind === 'multi') {
      if (!multiGroups.has(v.tag)) multiGroups.set(v.tag, []);
      multiGroups.get(v.tag).push(v);
      continue;
    }
    const lookup = buildLookup(v);
    const map = new Map();
    for (const [code, row] of usable) {
      const cell = (row[ci] || '').trim();
      if (!cell) continue;
      const level =
        mode === 'numeric'
          ? lookup.byCode.get(cell) || lookup.byLabel.get(normText(cell))
          : lookup.byLabel.get(normText(cell)) || lookup.byCode.get(cell);
      if (!level) {
        unparsed[v.key] = (unparsed[v.key] || 0) + 1;
        continue;
      }
      if (v.kind === 'ordinal') {
        if (level.value != null) map.set(code, level.value); // "Not sure" etc. stay missing
      } else {
        map.set(code, level.index);
      }
    }
    values.set(v.key, map);
  }

  // Multi-select: one column per option. Blank = not selected, unless the whole question was skipped.
  for (const vars of multiGroups.values()) {
    const cols = vars.map((v) => colIdx.get(v.column));
    const maps = vars.map(() => new Map());
    for (const [code, row] of usable) {
      const flags = cols.map((ci) => (row[ci] || '').trim() !== '');
      if (!flags.some(Boolean)) continue; // skipped the question: missing for every option
      flags.forEach((f, i) => maps[i].set(code, f ? 1 : 0));
    }
    vars.forEach((v, i) => values.set(v.key, maps[i]));
  }

  return {
    filename: options.filename || 'survey.csv',
    loadedAt: new Date().toISOString(),
    idColumn,
    mode,
    rowsInFile: rows.length - start,
    rowsUsed: usable.size,
    skippedTest,
    noCode,
    ambiguous: new Set(ambiguous),
    codes: new Set(usable.keys()),
    values,
    missingColumns,
    unparsed,
    columnsFound: found.length,
    columnsExpected: knownCols.size,
  };
}

module.exports = { parseSurveyExport, normCode, normText, UploadError };
