// Small helpers shared by the instructor pages. No third-party code, no external requests.
(function () {
  'use strict';
  const KEY_STORAGE = 'livepoll_instructor_key';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // The key lives in sessionStorage only (cleared when the tab closes) and travels in a header, never in a URL.
  function getKey() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { sessionStorage.setItem(KEY_STORAGE, k); } catch (e) { /* private mode: user will just re-enter it */ }
  }
  function forgetKey() {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* ignore */ }
  }

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || 'Request failed (' + status + ')');
      this.status = status;
      this.body = body || {};
    }
  }

  async function adminFetch(path, opts) {
    const o = opts || {};
    const headers = { 'x-instructor-key': getKey() };
    let body;
    if (o.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.json);
    }
    const res = await fetch(path, { method: o.method || (body ? 'POST' : 'GET'), headers, body });
    if (o.raw) {
      if (!res.ok) throw new ApiError(res.status, null);
      return res;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  // Shows the key box until a valid key is entered, then calls onReady().
  function setupGate(onReady) {
    const gate = document.getElementById('gate');
    const main = document.getElementById('main');
    const input = document.getElementById('key');
    const err = document.getElementById('gateError');
    let started = false;

    async function tryKey(k) {
      const res = await fetch('/api/admin/state', { headers: { 'x-instructor-key': k } });
      return res.ok;
    }
    function open() {
      if (started) return;
      started = true;
      gate.style.display = 'none';
      main.style.display = 'block';
      // open "new tab" links with window.open so the browser carries this tab's sign-in over
      document.querySelectorAll('a[data-newtab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href); }));
      onReady();
    }
    async function submit() {
      const k = input.value.trim();
      if (!k) return;
      if (await tryKey(k)) {
        setKey(k);
        input.value = '';
        open();
      } else {
        err.textContent = 'Incorrect key.';
      }
    }
    document.getElementById('unlockBtn').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const saved = getKey();
    if (saved) tryKey(saved).then((ok) => { if (ok) open(); else forgetKey(); });
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('Could not read that file.'));
      fr.readAsText(file);
    });
  }

  async function downloadFromApi(path, filename) {
    const res = await adminFetch(path, { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.Common = { esc, getKey, setKey, forgetKey, ApiError, adminFetch, setupGate, readFileText, downloadFromApi };
})();
