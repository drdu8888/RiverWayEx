(function () {
  'use strict';
  const { esc, adminFetch, setupGate } = window.Common;
  const R = window.Render;
  const el = (id) => document.getElementById(id);

  // idx: -1 = connections hidden (class sees only the histogram); 0.. = the connection on screen.
  const S = { pollId: '', idx: -1, all: false, data: null, lastTxt: null, lastPollShown: null };

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
    S.data = p;
    render();
  }

  function render() {
    const p = S.data;
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
      // a different statement is on screen: hide the connections again so the class sees the histogram first
      S.lastPollShown = p.poll.id;
      S.idx = -1;
      S.all = false;
    }
    el('pollLabel').textContent = p.poll.label;
    el('statement').textContent = p.poll.question;
    el('histo').innerHTML = R.histogramHtml(p.histogram.counts, p.scale);
    el('histoNote').textContent = p.histogram.total + ' response' + (p.histogram.total === 1 ? '' : 's') + (p.histogram.total ? ' · ' + R.agreeSummaryText(p.histogram.counts) : '');
    el('guide').innerHTML = R.readingGuideHtml(p);
    el('connKey').innerHTML = R.connectionKeyHtml();
    showConnections();
  }

  function showConnections() {
    const p = S.data;
    if (!p || !p.ready) return;
    const list = p.connections;
    const open = S.all || S.idx >= 0;
    el('connections').style.display = open ? '' : 'none';

    if (open) {
      if (!list.length) {
        el('connCount').textContent = '';
        el('connBody').innerHTML =
          '<p class="muted">' +
          esc(
            !p.surveyLoaded
              ? 'No survey data is loaded, so only comparisons with your earlier statements are possible, and none stands out.'
              : 'Nothing stands out for this statement: no two groups of ' + p.minGroup + ' or more classmates differ by ' + p.minGap + ' points or more.'
          ) +
          '</p>';
        el('connKey').style.display = 'none';
      } else {
        el('connKey').style.display = '';
        if (S.all) {
          el('connCount').textContent = 'All ' + list.length + ' connections, biggest differences first';
          el('connBody').innerHTML = list.map(R.connectionHtml).join('');
        } else {
          const i = Math.min(S.idx, list.length - 1);
          el('connCount').textContent = 'Connection ' + (i + 1) + ' of ' + list.length + ' · biggest differences first';
          el('connBody').innerHTML = R.connectionHtml(list[i]);
        }
      }
    }

    const n = list.length;
    el('backBtn').disabled = !open || (!S.all && S.idx < 0);
    const last = S.idx >= n - 1;
    el('nextBtn').disabled = S.all || (S.idx >= 0 && (last || !n)) ;
    el('nextBtn').textContent = S.idx < 0 ? 'Show what lines up' : last || !n ? 'That’s all of them' : 'Next connection →';
    el('allBtn').textContent = S.all ? 'Show one at a time' : 'Show all';
    el('allBtn').disabled = !n;
    el('hideBtn').disabled = !open;
  }

  function next() {
    if (el('nextBtn').disabled) return;
    S.idx += 1;
    showConnections();
  }
  function back() {
    if (el('backBtn').disabled) return;
    if (S.all) S.all = false;
    else S.idx -= 1;
    showConnections();
  }

  el('nextBtn').addEventListener('click', next);
  el('backBtn').addEventListener('click', back);
  el('allBtn').addEventListener('click', () => {
    S.all = !S.all;
    if (S.all && S.idx < 0) S.idx = 0;
    showConnections();
  });
  el('hideBtn').addEventListener('click', () => {
    S.idx = -1;
    S.all = false;
    showConnections();
  });
  el('pollSel').addEventListener('change', (e) => { S.pollId = e.target.value; S.lastTxt = null; load(); });
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') back();
  });

  setupGate(() => {
    load();
    setInterval(load, 3000);
  });
})();
