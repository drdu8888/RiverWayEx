(function () {
  'use strict';
  const { esc, adminFetch, setupGate } = window.Common;
  const R = window.Render;
  const el = (id) => document.getElementById(id);

  const S = { pollId: '', showPatterns: false, showAll: false, lastTxt: null, lastPollShown: null };

  async function load() {
    let p;
    try {
      p = await adminFetch('/api/admin/present' + (S.pollId ? '?poll=' + encodeURIComponent(S.pollId) : ''));
    } catch (e) {
      el('notReady').style.display = '';
      el('notReady').textContent = e.message;
      return;
    }
    const txt = JSON.stringify(p);
    if (txt === S.lastTxt) return;
    S.lastTxt = txt;
    render(p);
  }

  function render(p) {
    el('notReady').style.display = 'none';
    if (!p.ready) {
      el('stage').style.display = 'none';
      el('notReady').style.display = '';
      el('notReady').textContent = p.reason || 'Nothing to show yet.';
      return;
    }
    el('stage').style.display = '';

    // statement picker: "latest closed" plus every closed statement with enough responses
    const sel = el('pollSel');
    const opts = '<option value="">Latest closed statement</option>' + p.polls.map((q) => '<option value="' + esc(q.id) + '">' + esc(q.label + ': ' + q.question.slice(0, 70)) + '</option>').join('');
    if (sel.dataset.sig !== opts) {
      sel.innerHTML = opts;
      sel.dataset.sig = opts;
    }
    sel.value = S.pollId;

    if (S.lastPollShown !== p.poll.id) {
      // a different statement is on screen: hide the patterns again so the class sees the histogram first
      S.lastPollShown = p.poll.id;
      S.showPatterns = false;
      S.showAll = false;
    }
    el('pollLabel').textContent = p.poll.label;
    el('statement').textContent = p.poll.question;
    el('histo').innerHTML = R.histogramHtml(p.histogram.counts, p.scale);
    el('histoNote').textContent = p.histogram.total + ' response' + (p.histogram.total === 1 ? '' : 's');

    const rows = S.showAll ? p.rows : p.rows.slice(0, 8);
    el('patternRows').innerHTML = R.presentRowsHtml(Object.assign({}, p, { rows }));
    el('key2').innerHTML = R.likertKey(p.scale).replace(/^<div class="likert-key">|<\/div>$/g, '');
    el('moreBtn').style.display = p.rows.length > 8 ? '' : 'none';
    el('moreBtn').textContent = S.showAll ? 'Show fewer' : 'Show more';
    const caution = p.surveyLoaded ? R.classCaution(p.context) : null;
    el('caution').style.display = caution ? '' : 'none';
    if (caution) {
      el('caution').className = 'banner ' + caution.level;
      el('caution').innerHTML = '<strong>How much to trust this</strong>' + esc(caution.text);
    }
    el('patternNote').textContent = !p.surveyLoaded
      ? 'No survey data is loaded, so only relationships with your other statements can be shown.'
      : 'Strongest relationships first. Each pair of bars compares two groups of classmates; the number is the rank correlation (ρ). ' +
        (p.hidden ? p.hidden + ' variable' + (p.hidden === 1 ? ' is' : 's are') + ' hidden because one group would have fewer than ' + p.minGroup + ' students.' : '');

    if (p.polls.length > 1 && p.rows.length) {
      el('matrixCard').style.display = '';
      el('matrix').innerHTML = R.presentMatrixHtml(Object.assign({}, p, { rows }));
      el('legend').innerHTML = R.legendHtml();
    } else {
      el('matrixCard').style.display = 'none';
    }
    applyVisibility();
  }

  function applyVisibility() {
    el('patterns').style.display = S.showPatterns ? '' : 'none';
    el('toggleBtn').textContent = S.showPatterns ? 'Hide patterns' : 'Show patterns';
  }

  el('toggleBtn').addEventListener('click', () => { S.showPatterns = !S.showPatterns; applyVisibility(); });
  el('moreBtn').addEventListener('click', () => { S.showAll = !S.showAll; S.lastTxt = null; load(); });
  el('pollSel').addEventListener('change', (e) => { S.pollId = e.target.value; S.lastTxt = null; load(); });

  setupGate(() => {
    load();
    setInterval(load, 3000);
  });
})();
