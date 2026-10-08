// Pure rendering helpers for the heat map and detail panels (no DOM access, so they can be unit-tested in Node).
// Works in the browser (window.Render) and in Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Render = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Diverging colour-blind-safe palette: blue = agree LESS, orange = agree MORE.
  const NEG = [33, 102, 172];
  const POS = [179, 88, 6];
  const MID = [247, 247, 247];
  const FULL = 0.7; // |rho| at which the colour is fully saturated
  const LIKERT_COLORS = ['#2166ac', '#92c5de', '#d9d9d9', '#f4a582', '#b35806'];
  const LIKERT_TEXT = ['#fff', '#1c1d21', '#1c1d21', '#1c1d21', '#fff'];

  function color(rho) {
    if (rho == null) return { bg: null, fg: '#888' };
    const t = Math.min(1, Math.abs(rho) / FULL);
    const end = rho < 0 ? NEG : POS;
    const c = MID.map((m, i) => Math.round(m + (end[i] - m) * t));
    return { bg: 'rgb(' + c.join(',') + ')', fg: t > 0.55 ? '#fff' : '#1c1d21' };
  }

  const fmtRho = (r) => (r == null ? '–' : (r < 0 ? '−' : '+') + Math.abs(r).toFixed(2).replace(/^0/, ''));
  const fmtP = (p) => (p == null ? '–' : p < 0.0001 ? '<.0001' : p < 0.001 ? p.toFixed(4).replace(/^0/, '') : p.toFixed(3).replace(/^0/, ''));
  const fmtMean = (m) => (m == null ? '–' : m.toFixed(2));

  // cell = [rho, n, p, q]
  function marker(cell) {
    if (!cell || cell[0] == null) return '';
    if (cell[3] != null && cell[3] < 0.05) return '**';
    if (cell[3] != null && cell[3] < 0.1) return '*';
    if (cell[2] != null && cell[2] < 0.05) return '†';
    return '';
  }

  function strengthWord(rho) {
    const a = Math.abs(rho);
    return a < 0.1 ? 'negligible' : a < 0.3 ? 'weak' : a < 0.5 ? 'moderate' : 'strong';
  }

  // ---------- choosing which rows to show ----------
  // opts: sections:Set, pollIds:[], sortBy:'max'|'survey'|<pollId>, minAbs, onlyQ, search
  function selectRows(a, opts) {
    const o = opts || {};
    const pollIds = o.pollIds || a.polls.map((p) => p.id);
    const focus = o.sortBy && o.sortBy !== 'max' && o.sortBy !== 'survey' ? o.sortBy : null;
    const scan = focus ? [focus] : pollIds;
    const needle = (o.search || '').trim().toLowerCase();
    const out = [];
    a.rows.forEach((r, idx) => {
      if (o.sections && !o.sections.has(r.section)) return;
      if (needle && !r.label.toLowerCase().includes(needle)) return;
      const byPoll = a.cells[r.key] || {};
      let maxAbs = 0;
      let bestQ = 1;
      let any = false;
      for (const pid of scan) {
        const c = byPoll[pid];
        if (!c || c[0] == null) continue;
        any = true;
        maxAbs = Math.max(maxAbs, Math.abs(c[0]));
        if (c[3] != null) bestQ = Math.min(bestQ, c[3]);
      }
      if (!any) return;
      if (o.minAbs && maxAbs < o.minAbs) return;
      if (o.onlyQ && !(bestQ < 0.1)) return;
      out.push({ row: r, idx, maxAbs, bestQ });
    });
    if (o.sortBy === 'survey') out.sort((x, y) => x.idx - y.idx);
    else out.sort((x, y) => y.maxAbs - x.maxAbs || x.idx - y.idx);
    return out;
  }

  // ---------- heat map ----------
  function heatTable(a, selected, pollIds, focusId) {
    const polls = pollIds.map((id) => a.polls.find((p) => p.id === id)).filter(Boolean);
    const sectionLabel = Object.fromEntries(a.sections.map((s) => [s.id, s.label]));
    let h = '<table class="hm"><thead><tr><th class="corner">Survey variable</th>';
    for (const p of polls) {
      h += '<th class="ph' + (p.id === focusId ? ' focus' : '') + '" data-poll="' + esc(p.id) + '" title="' + esc(p.question) + '">' + esc(p.label) + '</th>';
    }
    h += '</tr></thead><tbody>';
    for (const { row } of selected) {
      h += '<tr><th class="rl" title="' + esc(sectionLabel[row.section] || '') + '"><span class="sec s-' + esc(row.section) + '"></span>' + esc(row.label) + '</th>';
      for (const p of polls) {
        const c = (a.cells[row.key] || {})[p.id];
        if (!c || c[0] == null) {
          h += '<td class="na">' + (c ? '<span title="Only ' + c[1] + ' matched students">·</span>' : '') + '</td>';
          continue;
        }
        const col = color(c[0]);
        const tip = 'rho ' + fmtRho(c[0]) + ', n = ' + c[1] + ', p = ' + fmtP(c[2]) + ', q = ' + fmtP(c[3]);
        h +=
          '<td class="v" data-row="' + esc(row.key) + '" data-poll="' + esc(p.id) + '" title="' + esc(tip) +
          '" style="background:' + col.bg + ';color:' + col.fg + '">' + fmtRho(c[0]) + '<sup>' + marker(c) + '</sup></td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  function legendHtml() {
    const stops = [-0.7, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 0.7];
    return (
      '<div class="legend"><span class="lg-end">agree less</span>' +
      stops.map((v) => '<span class="lg-cell" style="background:' + color(v).bg + ';color:' + color(v).fg + '">' + (v === 0 ? '0' : fmtRho(v)) + '</span>').join('') +
      '<span class="lg-end">agree more</span></div>'
    );
  }

  // ---------- chance check ----------
  function chanceVerdict(p) {
    const ch = p.chance || [];
    let hit = null;
    for (const c of ch) if (c.observed >= 3 && c.observed >= 3 * Math.max(c.expected, 0.3)) hit = c; // highest qualifying threshold wins
    if (hit) {
      return {
        level: 'above',
        text:
          'You see ' + hit.observed + ' correlations at |ρ| ≥ ' + hit.t.toFixed(1) + '; chance alone would give about ' + hit.expected +
          '. That is more than luck explains. Related survey items move together (for example, several AI questions), so these are not ' +
          hit.observed + ' independent findings.',
      };
    }
    return {
      level: 'near',
      text:
        'The number of strong correlations is about what chance alone would produce across this many comparisons. Treat the heat map as a source of leads to check, not as findings.',
    };
  }

  function smallNNote(p) {
    if (!p.matched || p.matched >= 60) return '';
    return (
      'With ' + p.matched + ' matched students and ' + p.tests + ' comparisons, correlations weaker than about ±' +
      (p.noiseCeiling != null ? p.noiseCeiling.toFixed(2).replace(/^0/, '') : '.6') +
      ' cannot be told apart from chance (fewer than one chance correlation is expected above that line). Real, moderate relationships are usually missed at this class size.'
    );
  }

  // Plain-language caution for the projected class view.
  function classCaution(ctx) {
    if (!ctx || !ctx.chance || !ctx.chance.length) return null;
    const v = chanceVerdict(ctx);
    const small = smallNNote({ matched: ctx.matched, tests: ctx.tests, noiseCeiling: ctx.noiseCeiling });
    if (v.level === 'above') {
      return { level: 'good', text: 'There are more strong patterns here than luck would produce, so some of them are probably real. Even so, a pattern is not a cause.' + (small ? ' ' + small : '') };
    }
    return {
      level: 'warn',
      text: 'About this many strong-looking patterns would turn up by luck alone when this many comparisons are made, so treat these as questions to discuss, not findings.' + (small ? ' ' + small : ''),
    };
  }

  function chanceTableHtml(p) {
    let h = '<table class="chance"><thead><tr><th>Correlation at least</th>';
    for (const c of p.chance) h += '<th>±' + c.t.toFixed(1) + '</th>';
    h += '</tr></thead><tbody><tr><th>You see</th>';
    for (const c of p.chance) h += '<td>' + c.observed + '</td>';
    h += '</tr><tr><th>Chance alone gives</th>';
    for (const c of p.chance) h += '<td>' + c.expected + '</td>';
    return h + '</tr></tbody></table>';
  }

  // ---------- distribution bars ----------
  function stackBar(dist, total) {
    if (!total) return '<div class="stack empty"></div>';
    let h = '<div class="stack">';
    dist.forEach((n, i) => {
      if (!n) return;
      const w = (n / total) * 100;
      h += '<span style="width:' + w.toFixed(2) + '%;background:' + LIKERT_COLORS[i] + ';color:' + LIKERT_TEXT[i] + '" title="' + n + '">' + (w >= 9 ? n : '') + '</span>';
    });
    return h + '</div>';
  }

  function likertKey(scale) {
    return (
      '<div class="likert-key">' +
      scale.map((l, i) => '<span><i style="background:' + LIKERT_COLORS[i] + '"></i>' + esc(l) + '</span>').join('') +
      '</div>'
    );
  }

  function groupsHtml(groups) {
    return groups
      .map(
        (g) =>
          '<div class="grp"><div class="grp-h"><span>' + esc(g.label) + '</span><span class="muted">n = ' + g.n + ' · mean ' + fmtMean(g.mean) + '</span></div>' +
          stackBar(g.dist, g.n) + '</div>'
      )
      .join('');
  }

  function histogramHtml(counts, scale) {
    const total = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...counts);
    return (
      '<div class="histo">' +
      counts
        .map(
          (n, i) =>
            '<div class="hcol"><div class="hnum">' + n + (total ? ' <small>(' + Math.round((n / total) * 100) + '%)</small>' : '') + '</div>' +
            '<div class="hbar" style="height:' + Math.round((n / max) * 100) + '%;background:' + LIKERT_COLORS[i] + '"></div>' +
            '<div class="hlab">' + esc(scale[i]) + '</div></div>'
        )
        .join('') +
      '</div>'
    );
  }

  // ---------- instructor detail panel ----------
  function describe(d) {
    const c = d.cell;
    if (c.rho == null) return 'Too few matched students for a correlation.';
    const w = strengthWord(c.rho);
    if (w === 'negligible') return 'Essentially no relationship (ρ = ' + fmtRho(c.rho) + ').';
    const more = c.rho > 0 ? 'more' : 'less';
    const who =
      d.row.kind === 'binary'
        ? 'Students in the group “' + d.groups[1].label + '”'
        : d.row.section === 'polls'
          ? 'Students who agreed more with ' + d.row.label.split(':')[0]
          : 'Students with higher scores on “' + d.row.label + '”';
    const verb = d.row.section === 'polls' ? 'also tended to agree ' + more : 'tended to agree ' + more;
    return who + ' ' + verb + ' with this statement (' + w + ' relationship, ρ = ' + fmtRho(c.rho) + (d.row.kind === 'binary' ? ', compared with everyone else' : '') + ').';
  }

  function detailHtml(d) {
    const c = d.cell;
    const m = marker([c.rho, c.n, c.p, c.q]);
    const sig =
      m === '**' ? 'Survives correction for multiple comparisons (q < .05).'
        : m === '*' ? 'Borderline after correction (q < .10).'
          : m === '†' ? 'Raw p < .05 but does NOT survive correction for the many comparisons run; with this many tests, some of these appear by chance alone.'
            : 'Not distinguishable from chance.';
    return (
      '<h3>' + esc(d.poll.label) + ' × ' + esc(d.row.label) + '</h3>' +
      '<p class="muted small">' + esc(d.poll.question) + '</p>' +
      '<p>' + esc(describe(d)) + '</p>' +
      '<p class="stats">ρ ' + fmtRho(c.rho) + ' · n ' + c.n + ' · p ' + fmtP(c.p) + ' · q ' + fmtP(c.q) + '</p>' +
      '<p class="muted small">' + esc(sig) + ' Correlation is not causation, and last-4 matching means some students may be missing.</p>' +
      groupsHtml(d.groups) +
      likertKey(d.scale)
    );
  }

  // ---------- class-safe (projected) view ----------
  // Returns a heat map with only rho values, no p-values, and a two-group comparison per row.
  function presentRowsHtml(p) {
    if (!p.rows.length) return '<p class="muted">No survey variable has two groups of at least ' + p.minGroup + ' students that line up with this statement.</p>';
    return p.rows
      .map((r) => {
        const rho = r.cells[p.poll.id] ? r.cells[p.poll.id][0] : null;
        return (
          '<div class="prow"><div class="prow-h"><span class="plabel">' + esc(r.label) + '</span><span class="pr" style="background:' + color(rho).bg + ';color:' + color(rho).fg + '">' +
          fmtRho(rho) + '</span></div>' + groupsHtml(r.groups) + '</div>'
        );
      })
      .join('');
  }

  function presentMatrixHtml(p) {
    const others = p.polls;
    let h = '<table class="hm"><thead><tr><th class="corner">Variable</th>';
    for (const q of others) h += '<th class="ph' + (q.id === p.poll.id ? ' focus' : '') + '" title="' + esc(q.question) + '">' + esc(q.label) + '</th>';
    h += '</tr></thead><tbody>';
    for (const r of p.rows) {
      h += '<tr><th class="rl">' + esc(r.label) + '</th>';
      for (const q of others) {
        const c = r.cells[q.id];
        if (!c || c[0] == null) {
          h += '<td class="na"></td>';
          continue;
        }
        const col = color(c[0]);
        h += '<td class="v" style="background:' + col.bg + ';color:' + col.fg + '">' + fmtRho(c[0]) + '</td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  return {
    esc, color, fmtRho, fmtP, marker, strengthWord, selectRows, heatTable, legendHtml, chanceVerdict, smallNNote, classCaution, chanceTableHtml,
    stackBar, likertKey, groupsHtml, histogramHtml, describe, detailHtml, presentRowsHtml, presentMatrixHtml, LIKERT_COLORS,
  };
});
