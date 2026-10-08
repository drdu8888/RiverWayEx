(function () {
  'use strict';
  const C = window.Common;
  const R = window.Render;
  const { esc, adminFetch, readFileText } = C;
  const el = (id) => document.getElementById(id);

  const S = { a: null, focus: null, pollIds: null, sections: null, pick: null, pendingCsv: null, pendingName: null, detailSeq: 0 };

  // ---------- loading ----------
  async function load(force) {
    const open = el('includeOpen').checked ? '1' : '0';
    let fresh;
    try {
      fresh = await adminFetch('/api/admin/analysis?includeOpen=' + open);
    } catch (e) {
      el('pollTable').innerHTML = '<div class="banner bad">' + esc(e.message) + '</div>';
      return;
    }
    const txt = JSON.stringify(fresh);
    if (!force && txt === S.lastTxt) return; // nothing changed since the last refresh
    S.lastTxt = txt;
    S.a = fresh;
    const a = S.a;
    const ids = a.polls.map((p) => p.id);
    if (!S.pollIds) S.pollIds = new Set(ids);
    else S.pollIds = new Set([...S.pollIds].filter((id) => ids.includes(id)).concat(ids.filter((id) => !S.known || !S.known.has(id))));
    S.known = new Set(ids);
    if (!S.sections) S.sections = new Set(a.sections.map((s) => s.id));
    if (!S.focus || !ids.includes(S.focus)) S.focus = ids.length ? ids[ids.length - 1] : null;
    renderSurveyStatus();
    renderPolls();
    renderChips();
    renderSortOptions();
    renderChance();
    renderHeat();
  }

  // ---------- 1. survey status & upload ----------
  function renderSurveyStatus() {
    const s = S.a.survey;
    el('clearBtn').style.display = s ? '' : 'none';
    if (!s) {
      el('surveyStatus').innerHTML = '<div class="banner warn"><strong>No survey loaded</strong>Only poll-versus-poll relationships can be shown until you upload the survey export.</div>';
      return;
    }
    const probs = [];
    if (s.skippedTest) probs.push(s.skippedTest + ' preview/test response' + (s.skippedTest === 1 ? '' : 's') + ' skipped');
    if (s.noCode) probs.push(s.noCode + ' response' + (s.noCode === 1 ? '' : 's') + ' with no usable last-4 code (can’t be matched)');
    if (s.ambiguousCodes.length) probs.push(s.ambiguousCodes.length + ' last-4 code' + (s.ambiguousCodes.length === 1 ? ' is' : 's are') + ' shared by more than one respondent (' + s.ambiguousCodes.map(esc).join(', ') + '): those students are excluded rather than guessed at');
    const miss = s.missingColumns.length ? '<div class="status">Expected columns not in the file (' + s.missingColumns.length + '): ' + s.missingColumns.slice(0, 8).map(esc).join(', ') + (s.missingColumns.length > 8 ? ', …' : '') + '</div>' : '';
    const un = Object.entries(s.unparsed || {});
    const unTxt = un.length ? '<div class="status">Answers not recognised (' + un.length + ' column' + (un.length === 1 ? '' : 's') + '): ' + un.slice(0, 6).map(([k, v]) => esc(k) + ' ×' + v).join(', ') + (un.length > 6 ? ', …' : '') + '. Treated as missing.</div>' : '';
    el('surveyStatus').innerHTML =
      '<div class="banner good"><strong>Survey loaded in server memory</strong>' +
      esc(s.filename || 'survey file') + ' · ' + s.rowsUsed + ' of ' + s.rowsInFile + ' responses usable · matched on “' + esc(s.idColumn) + '” · export style: ' +
      (s.mode === 'numeric' ? 'numeric values' : 'choice text') + ' · ' + s.columnsFound + ' of ' + s.columnsExpected + ' expected question columns found' +
      (probs.length ? '<ul style="margin:6px 0 0 18px;padding:0;">' + probs.map((p) => '<li>' + p + '</li>').join('') + '</ul>' : '') + miss + unTxt + '</div>';
  }

  async function uploadSurvey(csv, name, idColumn) {
    el('uploadMsg').innerHTML = '<div class="status">Uploading and parsing…</div>';
    el('idPicker').style.display = 'none';
    try {
      const r = await adminFetch('/api/admin/survey', { json: { csv, filename: name, idColumn: idColumn || undefined } });
      S.pendingCsv = null;
      el('uploadMsg').innerHTML = '<div class="status">Loaded ' + r.survey.rowsUsed + ' responses.</div>';
      S.pollIds = null; // reset columns for a fresh survey
      await load(true);
    } catch (e) {
      if (e.body && e.body.needsIdColumn) {
        S.pendingCsv = csv;
        S.pendingName = name;
        el('idSelect').innerHTML = e.body.headers.map((h) => '<option>' + esc(h) + '</option>').join('');
        el('idPicker').style.display = '';
        el('uploadMsg').innerHTML = '';
      } else {
        el('uploadMsg').innerHTML = '<div class="banner bad">' + esc(e.message) + '</div>';
      }
    }
  }

  async function handleSurveyFile(file) {
    if (!file) return;
    try { uploadSurvey(await readFileText(file), file.name); } catch (e) { el('uploadMsg').innerHTML = '<div class="banner bad">' + esc(e.message) + '</div>'; }
  }
  el('surveyFile').addEventListener('change', (e) => handleSurveyFile(e.target.files[0]));
  el('idGo').addEventListener('click', () => S.pendingCsv && uploadSurvey(S.pendingCsv, S.pendingName, el('idSelect').value));
  const drop = el('uploadBox');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleSurveyFile(e.dataTransfer.files[0]));

  el('clearBtn').addEventListener('click', async () => {
    if (!window.confirm('Remove the survey data from the server’s memory? You will need to upload it again to see survey patterns.')) return;
    await adminFetch('/api/admin/survey/clear', { method: 'POST' });
    S.pollIds = null;
    S.pick = null;
    el('detail').innerHTML = '<p class="muted">Click a cell in the heat map to see how the poll answers break down.</p>';
    load(true);
  });

  el('pollFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await adminFetch('/api/admin/import-polls', { json: { csv: await readFileText(f) } });
      el('pollImportMsg').textContent = 'Imported ' + r.imported + ' round(s); ' + r.skipped + ' already present' + (r.custom ? '; ' + r.custom + ' were not 5-point statements and will be ignored by the analysis' : '') + '.';
      S.pollIds = null;
      load(true);
    } catch (err) {
      el('pollImportMsg').textContent = err.message;
    }
  });

  // ---------- 2. polls ----------
  function renderPolls() {
    const a = S.a;
    if (!a.polls.length) {
      el('pollTable').innerHTML = '<div class="banner warn">No 5-point poll has at least 8 responses yet. Run a poll, close it, and come back.</div>';
    } else {
      let h = '<table class="tbl"><thead><tr><th></th><th>Statement</th><th class="num">Votes</th>' +
        (a.survey ? '<th class="num">Matched to survey</th><th>Not matched</th>' : '') + '<th class="num">Comparisons</th></tr></thead><tbody>';
      for (const p of a.polls) {
        const unm = p.unmatched.length ? 'code' + (p.unmatched.length === 1 ? '' : 's') + ' ' + p.unmatched.map(esc).join(', ') + ' (typo, or not in the survey)' : '';
        const amb = p.ambiguous ? (unm ? '; ' : '') + p.ambiguous + ' with a shared code' : '';
        h += '<tr class="clickable' + (p.id === S.focus ? ' sel' : '') + '" data-poll="' + esc(p.id) + '"><td><strong>' + esc(p.label) + '</strong></td><td>' + esc(p.question) + (p.isOpen ? ' <span class="pill open">open</span>' : '') +
          '</td><td class="num">' + p.votes + '</td>' + (a.survey ? '<td class="num">' + p.matched + '</td><td class="muted">' + (unm + amb || '—') + '</td>' : '') + '<td class="num">' + p.tests + '</td></tr>';
      }
      el('pollTable').innerHTML = h + '</tbody></table>';
    }
    el('skippedNote').textContent = a.skipped.length
      ? 'Skipped (fewer than 8 responses): ' + a.skipped.map((p) => p.label + ' (' + p.votes + ')').join(', ') + '. Poll numbers (P1, P2…) follow the order the statements were run, so a gap means a statement was skipped.'
      : '';
  }
  el('pollTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-poll]');
    if (!tr) return;
    S.focus = tr.dataset.poll;
    el('sortBy').value = S.focus;
    renderPolls();
    renderChance();
    renderHeat();
  });
  el('includeOpen').addEventListener('change', () => load(true));

  // ---------- 3. chance check ----------
  function renderChance() {
    const p = S.a.polls.find((x) => x.id === S.focus);
    el('chanceCard').style.display = p ? '' : 'none';
    if (!p) return;
    el('chancePoll').textContent = '· ' + p.label + ': ' + p.question;
    const v = R.chanceVerdict(p);
    const note = R.smallNNote(p);
    el('chanceBody').innerHTML =
      '<p style="margin-top:0;">If nothing were truly related, a few correlations would still look strong by luck, because ' + p.tests + ' comparisons are being made. This compares what you see with what luck alone would give.</p>' +
      R.chanceTableHtml(p) +
      '<div class="banner ' + (v.level === 'above' ? 'good' : 'warn') + '"><strong>' + (v.level === 'above' ? 'More than chance' : 'Looks like chance') + '</strong>' + esc(v.text) + '</div>' +
      (note ? '<div class="banner info">' + esc(note) + '</div>' : '') +
      '<p class="muted small" style="margin-bottom:0;">Chance figures assume unrelated variables and use the number of matched students for each cell (a standard approximation, checked against simulation). Survey items from the same question block are correlated with one another, so strong cells tend to arrive in clusters.</p>';
  }

  // ---------- 4. heat map ----------
  function renderChips() {
    const a = S.a;
    el('secChips').innerHTML = a.sections
      .filter((s) => a.rows.some((r) => r.section === s.id))
      .map((s) => '<label><input type="checkbox" data-sec="' + esc(s.id) + '"' + (S.sections.has(s.id) ? ' checked' : '') + '><span class="sec s-' + esc(s.id) + '" style="margin:0"></span>' + esc(s.label) + '</label>')
      .join('');
    el('pollChips').innerHTML = a.polls
      .map((p) => '<label title="' + esc(p.question) + '"><input type="checkbox" data-pollchip="' + esc(p.id) + '"' + (S.pollIds.has(p.id) ? ' checked' : '') + '>' + esc(p.label) + '</label>')
      .join('');
  }
  el('secChips').addEventListener('change', (e) => {
    const id = e.target.dataset.sec;
    if (!id) return;
    e.target.checked ? S.sections.add(id) : S.sections.delete(id);
    renderHeat();
  });
  el('pollChips').addEventListener('change', (e) => {
    const id = e.target.dataset.pollchip;
    if (!id) return;
    e.target.checked ? S.pollIds.add(id) : S.pollIds.delete(id);
    renderHeat();
  });

  function renderSortOptions() {
    const sel = el('sortBy');
    const cur = sel.value;
    sel.innerHTML =
      '<option value="max">strongest in any shown poll</option>' +
      S.a.polls.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label + ': ' + p.question.slice(0, 55)) + '</option>').join('') +
      '<option value="survey">survey order</option>';
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'max';
  }

  function currentSelection() {
    const sortBy = el('sortBy').value;
    const pollIds = S.a.polls.map((p) => p.id).filter((id) => S.pollIds.has(id));
    return {
      pollIds,
      all: R.selectRows(S.a, {
        sections: S.sections, pollIds, sortBy, minAbs: parseFloat(el('minAbs').value) || 0,
        onlyQ: el('onlyQ').checked, search: el('search').value,
      }),
    };
  }

  function renderHeat() {
    const a = S.a;
    if (!a.polls.length) {
      el('heat').innerHTML = '<p class="muted" style="padding:16px;">Nothing to show yet.</p>';
      el('legend').innerHTML = '';
      el('shownCount').textContent = '';
      return;
    }
    const { pollIds, all } = currentSelection();
    const limit = parseInt(el('limit').value, 10) || 40;
    const shown = all.slice(0, limit);
    const sortBy = el('sortBy').value;
    el('heat').innerHTML = shown.length ? R.heatTable(a, shown, pollIds, sortBy !== 'max' && sortBy !== 'survey' ? sortBy : S.focus) : '<p class="muted" style="padding:16px;">No variables match these filters.</p>';
    el('legend').innerHTML = R.legendHtml() + '<div class="marks">** q &lt; .05 · * q &lt; .10 · † raw p &lt; .05 only · hatched = too few matched students · ρ = Spearman rank correlation</div>';
    el('shownCount').textContent = 'Showing ' + shown.length + ' of ' + all.length + ' variables that match the filters.';
    if (S.pick) {
      const td = el('heat').querySelector('td.v[data-row="' + CSS.escape(S.pick.row) + '"][data-poll="' + CSS.escape(S.pick.poll) + '"]');
      if (td) td.classList.add('pick');
    }
  }
  ['sortBy', 'limit', 'minAbs', 'onlyQ'].forEach((id) => el(id).addEventListener('change', renderHeat));
  el('search').addEventListener('input', renderHeat);

  el('heat').addEventListener('click', async (e) => {
    const th = e.target.closest('th.ph');
    if (th) {
      S.focus = th.dataset.poll;
      el('sortBy').value = S.focus;
      renderPolls();
      renderChance();
      renderHeat();
      return;
    }
    const td = e.target.closest('td.v');
    if (!td) return;
    S.pick = { row: td.dataset.row, poll: td.dataset.poll };
    el('heat').querySelectorAll('td.pick').forEach((x) => x.classList.remove('pick'));
    td.classList.add('pick');
    const seq = ++S.detailSeq;
    const open = el('includeOpen').checked ? '1' : '0';
    try {
      const d = await adminFetch('/api/admin/detail?poll=' + encodeURIComponent(S.pick.poll) + '&row=' + encodeURIComponent(S.pick.row) + '&includeOpen=' + open);
      if (seq === S.detailSeq) el('detail').innerHTML = R.detailHtml(d);
    } catch (err) {
      el('detail').innerHTML = '<div class="banner bad">' + esc(err.message) + '</div>';
    }
  });

  el('csvBtn').addEventListener('click', () => {
    const { pollIds, all } = currentSelection();
    const limit = parseInt(el('limit').value, 10) || 40;
    const polls = pollIds.map((id) => S.a.polls.find((p) => p.id === id));
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const head = ['variable', 'section'];
    polls.forEach((p) => head.push(p.label + ' rho', p.label + ' n', p.label + ' p', p.label + ' q'));
    const lines = [head.map(q).join(',')];
    for (const { row } of all.slice(0, limit)) {
      const cells = [q(row.label), q(row.section)];
      for (const p of polls) {
        const c = (S.a.cells[row.key] || {})[p.id] || [null, null, null, null];
        cells.push(...c.map((v) => (v == null ? '' : v)));
      }
      lines.push(cells.join(','));
    }
    const note = '\n\n' + polls.map((p) => q(p.label + ' = ' + p.question)).join('\n') + '\n';
    const blob = new Blob([lines.join('\n') + note], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'heatmap_correlations.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---------- 5. class-safe sections ----------
  async function loadPresentConfig() {
    const cfg = await adminFetch('/api/admin/present-config');
    el('presentChips').innerHTML = cfg.sections
      .map((s) => '<label><input type="checkbox" data-psec="' + esc(s.id) + '"' + (s.included ? ' checked' : '') + '><span class="sec s-' + esc(s.id) + '" style="margin:0"></span>' + esc(s.label) + (s.sensitive ? ' <span class="pill closed">sensitive</span>' : '') + '</label>')
      .join('');
  }
  el('presentChips').addEventListener('change', async () => {
    const ids = [...el('presentChips').querySelectorAll('input:checked')].map((i) => i.dataset.psec);
    await adminFetch('/api/admin/present-config', { json: { sections: ids } });
  });
  el('openPresent').addEventListener('click', () => window.open('/present.html'));

  C.setupGate(() => {
    load(true);
    loadPresentConfig();
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  });
})();
