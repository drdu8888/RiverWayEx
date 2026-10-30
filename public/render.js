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

  // ---------- class-safe (projected) view: plain-English connections ----------
  // A "connection" (built by the server) compares two groups of classmates, defined by a survey answer, on how
  // many of them Agreed / Strongly agreed with the statement just polled:
  //   { type, question, item, gap, beyondLuck, more:{label,yes,n,agree,disagree,neutral,pct}, less:{...} }
  // Nothing here uses statistical vocabulary; the sentence says who was more likely to agree, and the bars show it.
  const SEG = { d: LIKERT_COLORS[0], u: '#d9d9d9', a: LIKERT_COLORS[4] };

  function pct(n, total) {
    return total ? Math.round((n / total) * 100) : 0;
  }

  // "62% agreed · 23% neutral · 15% disagreed" for the histogram caption (the three always add to 100).
  function agreeSummary(counts) {
    const total = counts.reduce((x, y) => x + y, 0);
    if (!total) return null;
    const agree = pct(counts[3] + counts[4], total);
    const disagree = pct(counts[0] + counts[1], total);
    return { total, agree, disagree, neutral: Math.max(0, 100 - agree - disagree) };
  }

  function agreeSummaryText(counts) {
    const s = agreeSummary(counts);
    return s ? s.agree + '% agreed · ' + s.neutral + '% neutral · ' + s.disagree + '% disagreed' : '';
  }

  function degreeWord(gap) {
    return gap >= 50 ? 'much more likely' : gap >= 30 ? 'more likely' : 'somewhat more likely';
  }

  const q = (t) => '<b>“' + esc(t) + '”</b>';

  // "answered “X”" / "selected “X”" for one side of the comparison. `second` = the comparison group (shorter wording).
  function groupPhrase(c, g, second) {
    if (c.type === 'nominal') {
      if (g.yes) return 'answered ' + q(c.item);
      return second ? 'answered something else' : 'answered something other than ' + q(c.item);
    }
    if (c.type === 'multi') {
      if (g.yes) return second ? 'did' : 'selected ' + q(c.item);
      return second ? 'did not' : 'did not select ' + q(c.item);
    }
    if (c.type === 'poll') return 'answered ' + q(g.label) + (second ? '' : ' on ' + esc(c.item));
    return 'answered ' + q(g.label);
  }

  // Label printed above each bar: who is in this group.
  function groupBarLabel(c, g) {
    if (c.type === 'nominal') return g.yes ? 'Answered “' + c.item + '”' : 'Answered something other than “' + c.item + '”';
    if (c.type === 'multi') return g.yes ? 'Selected “' + c.item + '”' : 'Did not select “' + c.item + '”';
    if (c.type === 'poll') return 'Answered “' + g.label + '” on ' + c.item;
    return 'Answered “' + g.label + '”';
  }

  // The headline sentence, with the numbers that back it up.
  function connectionSentenceHtml(c) {
    const m = c.more;
    const l = c.less;
    const md = pct(m.disagree, m.n);
    const ld = pct(l.disagree, l.n);
    let s =
      'Students who ' + groupPhrase(c, m, false) + ' were <em class="deg">' + degreeWord(c.gap) + '</em> to agree with this statement than students who ' +
      groupPhrase(c, l, true) + ' <span class="nums">(' + m.pct + '% agreed vs. ' + l.pct + '%)</span>.';
    if (ld - md >= 10) s += ' They were also less likely to disagree <span class="nums">(' + md + '% vs. ' + ld + '%)</span>.';
    return s;
  }

  // Where the comparison comes from: { tag, stem, main }.
  function connectionHead(c) {
    if (c.type === 'poll') return { tag: 'Earlier class statement (' + c.item + ')', stem: '', main: '“' + c.question + '”' };
    if (c.type === 'matrix') return { tag: 'On the survey', stem: c.question, main: c.item };
    if (c.type === 'multi') return { tag: 'On the survey (choose all that apply)', stem: '', main: c.question };
    return { tag: 'On the survey', stem: '', main: c.question };
  }

  const SEG_WORD = { d: 'disagreed', u: 'neutral', a: 'agreed' };

  // One group's bar: three labelled segments (disagreed / neutral / agreed) plus the counts in words.
  function connectionBarHtml(c, g, cls) {
    const seg = (n, key) => {
      if (!n) return '';
      const share = n / g.n;
      const p = pct(n, g.n) + '%';
      const txt = share >= 0.22 ? p + ' ' + SEG_WORD[key] : share >= 0.09 ? p : '';
      return '<span class="seg ' + key + '" title="' + p + ' ' + SEG_WORD[key] + ' (' + n + ' of ' + g.n + ')" style="width:' + (share * 100).toFixed(2) + '%;background:' + SEG[key] + '">' + txt + '</span>';
    };
    return (
      '<div class="cb ' + cls + '"><div class="cb-h"><span class="cb-lab">' + esc(groupBarLabel(c, g)) + ' <small>(' + g.n + ' students)</small></span>' +
      '<span class="cb-pct">' + g.pct + '% <small>agreed</small></span></div>' +
      '<div class="cb-bar">' + seg(g.disagree, 'd') + seg(g.neutral, 'u') + seg(g.agree, 'a') + '</div>' +
      '<div class="cb-n">' + g.disagree + ' disagreed · ' + g.neutral + ' neutral · ' + g.agree + ' agreed</div></div>'
    );
  }

  // Legend shown on every card, right above the bars.
  function connectionLegendHtml() {
    return (
      '<div class="conn-legend"><span class="lg-lead">Each bar shows how that group voted on today’s statement:</span>' +
      '<span><i style="background:' + SEG.d + '"></i>Disagreed or strongly disagreed</span>' +
      '<span><i style="background:' + SEG.u + '"></i>Neutral</span>' +
      '<span><i style="background:' + SEG.a + '"></i>Agreed or strongly agreed</span></div>'
    );
  }

  function luckNoteHtml(c) {
    return c.beyondLuck
      ? '<p class="luck beyond"><strong>Bigger than luck usually makes.</strong> A gap this large would be unusual by chance in a class this size, though it still cannot tell us <em>why</em>.</p>'
      : '<p class="luck"><strong>Could be a coincidence.</strong> In a class this size, gaps like this can happen by luck alone. Does it make sense to you?</p>';
  }

  function connectionHtml(c) {
    const h = connectionHead(c);
    return (
      '<article class="conn">' +
      '<div class="conn-head"><span class="conn-tag">' + esc(h.tag) + '</span>' +
      (h.stem ? '<span class="conn-stem">' + esc(h.stem) + '</span>' : '') +
      '<span class="conn-main">' + esc(h.main) + '</span></div>' +
      '<p class="conn-s">' + connectionSentenceHtml(c) + '</p>' +
      connectionLegendHtml() +
      '<div class="cb-pair">' + connectionBarHtml(c, c.more, 'hi') + connectionBarHtml(c, c.less, 'lo') + '</div>' +
      luckNoteHtml(c) +
      '</article>'
    );
  }

  // The legend now sits on every card (connectionLegendHtml); kept for compatibility.
  function connectionKeyHtml() {
    return '';
  }

  // The one-time "how to read this" text under the connections.
  function readingGuideHtml(p) {
    const luck =
      p.luckGap == null
        ? ''
        : p.luckGap >= 90
          ? ' In a class this small, even a very large gap can be a coincidence.'
          : ' With this many comparisons in a class this size, two typical-sized groups need to differ by roughly ' + p.luckGap + ' points before luck stops being a likely explanation.';
    return (
      '<h3>How to read this</h3>' +
      '<p>Each card compares two groups of classmates who answered a survey question differently, and shows how many in each group <strong>agreed</strong> with the statement we just voted on. ' +
      'Only groups of ' + p.minGroup + ' or more students are ever shown, and nobody is named.</p>' +
      '<p>We are comparing many survey questions in a small class, so some of these gaps are pure coincidence.' + luck +
      ' Treat each card as a question, not an answer:</p>' +
      '<ul><li>Does this surprise you? Why or why not?</li><li>What else, besides the survey answer, could explain it?</li><li>Would you expect the same in a different class?</li></ul>'
    );
  }

  return {
    esc, color, fmtRho, fmtP, marker, strengthWord, selectRows, heatTable, legendHtml, chanceVerdict, smallNNote, chanceTableHtml,
    stackBar, likertKey, groupsHtml, histogramHtml, describe, detailHtml, LIKERT_COLORS,
    agreeSummary, agreeSummaryText, degreeWord, groupPhrase, groupBarLabel, connectionSentenceHtml, connectionHead, connectionHtml,
    connectionKeyHtml, connectionLegendHtml, connectionBarHtml, readingGuideHtml,
  };
});
