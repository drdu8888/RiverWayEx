(function () {
  'use strict';
  const { esc, adminFetch, setupGate, downloadFromApi } = window.Common;
  const R = window.Render;
  const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

  const el = (id) => document.getElementById(id);
  const dist = (results) => LIKERT.map((l) => (results && results[l]) || 0);

  async function refresh() {
    try {
      const data = await adminFetch('/api/admin/state');
      renderCurrent(data.round);
      renderHistory(data.history);
    } catch (e) { /* transient */ }
  }

  function renderCurrent(round) {
    const pill = el('statusPill');
    if (!round) {
      pill.textContent = '';
      el('currentQ').textContent = 'No statement started yet.';
      el('liveResults').innerHTML = '';
      el('closeBtn').disabled = true;
      el('reopenBtn').disabled = true;
      return;
    }
    pill.textContent = round.isOpen ? 'Open' : 'Closed';
    pill.className = 'pill ' + (round.isOpen ? 'open' : 'closed');
    el('currentQ').innerHTML = '<strong>' + esc(round.question) + '</strong>';
    el('closeBtn').disabled = !round.isOpen;
    el('reopenBtn').disabled = round.isOpen;
    el('liveResults').innerHTML =
      R.histogramHtml(dist(round.results), LIKERT) +
      '<div class="status">' + round.totalVotes + ' response' + (round.totalVotes === 1 ? '' : 's') + ' so far.</div>';
  }

  function renderHistory(history) {
    const box = el('history');
    if (!history || !history.length) {
      box.innerHTML = '<p class="status">No statements yet.</p>';
      return;
    }
    box.innerHTML = history
      .slice()
      .reverse()
      .map((r) => {
        const d = dist(r.results);
        return (
          '<div class="history-item"><strong>' + esc(r.question) + '</strong> <span class="pill ' + (r.isOpen ? 'open' : 'closed') + '">' + (r.isOpen ? 'Open' : 'Closed') + '</span>' +
          '<div class="status" style="margin:4px 0 6px;">' + r.totalVotes + ' response' + (r.totalVotes === 1 ? '' : 's') + (r.scale === 'custom' ? ' · not a 5-point statement, excluded from analysis' : '') + '</div>' +
          (r.scale === 'likert5' ? R.stackBar(d, r.totalVotes) : '') + '</div>'
        );
      })
      .join('') + R.likertKey(LIKERT);
  }

  el('startBtn').addEventListener('click', async () => {
    const question = el('question').value.trim();
    el('startError').textContent = '';
    try {
      await adminFetch('/api/admin/round', { json: { question } });
      el('question').value = '';
      refresh();
    } catch (e) {
      el('startError').textContent = e.message;
    }
  });
  el('closeBtn').addEventListener('click', async () => { await adminFetch('/api/admin/close', { method: 'POST' }); refresh(); });
  el('reopenBtn').addEventListener('click', async () => { await adminFetch('/api/admin/reopen', { method: 'POST' }); refresh(); });
  el('exportBtn').addEventListener('click', async () => {
    try { await downloadFromApi('/api/admin/export', 'poll_responses.csv'); } catch (e) { el('exportNote').textContent = 'Download failed: ' + e.message; }
  });

  setupGate(() => {
    refresh();
    setInterval(refresh, 1500);
  });
})();
