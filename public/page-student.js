(function () {
  'use strict';
  const codeInput = document.getElementById('code');
  const codeStatus = document.getElementById('codeStatus');
  const pollBody = document.getElementById('pollBody');
  const STORAGE_KEY = 'livepoll_code';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  try { codeInput.value = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { /* storage unavailable */ }

  let submitting = false;

  // digits only, at most 4
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
    try { localStorage.setItem(STORAGE_KEY, codeInput.value); } catch (e) { /* ignore */ }
    codeStatus.textContent = '';
    refresh();
  });

  const getCode = () => codeInput.value.replace(/\D/g, '');

  function setStatus(msg, isError) {
    codeStatus.textContent = msg;
    codeStatus.className = 'status' + (isError ? ' error' : '');
  }

  async function submitVote(choice) {
    const code = getCode();
    if (code.length !== 4) {
      setStatus('Enter exactly 4 digits first.', true);
      codeInput.focus();
      return;
    }
    submitting = true;
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, choice }),
      });
      const data = await res.json();
      setStatus(res.ok ? '' : data.error || 'Could not submit your answer.', !res.ok);
    } catch (e) {
      setStatus('Network error. Try again.', true);
    }
    submitting = false;
    refresh();
  }

  function renderWaiting() {
    pollBody.innerHTML = '<p>Waiting for the instructor to start a question…</p>';
  }

  function renderOpen(round) {
    pollBody.innerHTML =
      '<span class="pill open">Open</span><h2 style="margin-top:10px;">' + esc(round.question) + '</h2>' +
      round.options
        .map((opt) => '<button class="option-btn' + (opt === round.yourVote ? ' selected' : '') + '" data-choice="' + esc(opt) + '">' + esc(opt) + '</button>')
        .join('') +
      '<div class="status">' + (round.yourVote ? 'Recorded. You can change your answer until the poll closes.' : 'Choose an answer above.') + '</div>';
    pollBody.querySelectorAll('.option-btn').forEach((btn) => btn.addEventListener('click', () => submitVote(btn.dataset.choice)));
  }

  function renderClosed(round) {
    const total = round.totalVotes || 0;
    const rows = round.options
      .map((opt) => {
        const count = round.results[opt] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          '<div class="bar-row"><div class="bar-label"><span>' + esc(opt) + (opt === round.yourVote ? ' (your answer)' : '') + '</span><span>' + count + ' (' + pct + '%)</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div></div>'
        );
      })
      .join('');
    pollBody.innerHTML =
      '<span class="pill closed">Closed</span><h2 style="margin-top:10px;">' + esc(round.question) + '</h2>' + rows +
      '<div class="status">' + total + ' response' + (total === 1 ? '' : 's') + ' total.</div>';
  }

  async function refresh() {
    if (submitting) return;
    try {
      const code = getCode();
      const res = await fetch('/api/state' + (code.length === 4 ? '?code=' + encodeURIComponent(code) : ''));
      const round = (await res.json()).round;
      if (!round) renderWaiting();
      else if (round.isOpen) renderOpen(round);
      else renderClosed(round);
    } catch (e) {
      /* keep what is on screen through a brief network drop */
    }
  }

  refresh();
  setInterval(refresh, 2000);
})();
