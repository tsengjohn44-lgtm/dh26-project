// History of every Perceptron reply and what the app did with it, kept on the phone across
// reloads (localStorage). Nothing else stores replies: the server logs none, and the main screen
// only shows the last two alerts. Viewed in the History sheet (ui.js). Runs in the browser
// (window.Log); createLog also loads in Node for tests.
(function (root) {
  const KEY = 'replyLog';
  const MAX_ENTRIES = 1000;  // ~150 KB as JSON; localStorage allows ~5 MB per site
  const SAVE_DELAY_MS = 1000; // replies arrive 2-3 a second: write at most once a second
  // Shown (and spoken) to the user; the rest are replies the filter dropped, plus errors.
  const SPOKEN = new Set(['alert', 'correction', 'answer', 'hint']);
  const KINDS = new Set(['alert', 'correction', 'answer', 'hint', 'repeat', 'n/a', 'late', 'error']);

  function createLog({ storage = root.localStorage, setTimer = setTimeout, now = Date.now } = {}) {
    let list = load();
    let timer = null;
    const listeners = [];

    function load() {
      try {
        const data = JSON.parse(storage.getItem(KEY) || '[]');
        return Array.isArray(data) ? data.filter((e) => e && typeof e.text === 'string' && KINDS.has(e.kind)).slice(-MAX_ENTRIES) : [];
      } catch { return []; } // blocked storage (private mode) or corrupt data: start empty
    }
    function save() {
      timer = null;
      try { storage.setItem(KEY, JSON.stringify(list)); } catch { /* full or blocked: keep it in memory */ }
    }
    function flush() { if (timer !== null) save(); }

    // entry: { kind, text, ms?, mode? }; t (epoch ms) is added here.
    function add(entry) {
      if (!entry || !KINDS.has(entry.kind)) return null;
      const e = { t: now(), kind: entry.kind, text: String(entry.text ?? '').replace(/\s+/g, ' ').trim() };
      if (Number.isFinite(entry.ms)) e.ms = Math.round(entry.ms);
      if (entry.mode) e.mode = entry.mode;
      list.push(e);
      if (list.length > MAX_ENTRIES) list = list.slice(-MAX_ENTRIES);
      if (timer === null) timer = setTimer(save, SAVE_DELAY_MS);
      for (const fn of listeners) { try { fn(e); } catch { /* a broken view must not stop logging */ } }
      return e;
    }
    function clear() {
      list = [];
      timer = null;
      try { storage.removeItem(KEY); } catch { /* blocked */ }
    }
    const isSpoken = (e) => SPOKEN.has(e.kind);
    const entries = (filter = 'all') => (filter === 'spoken' ? list.filter(isSpoken) : list.slice());

    function time(t) {
      const d = new Date(t), p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    // Plain text, oldest first, with the date once per day: for Copy.
    function toText(filter = 'all') {
      let day = '';
      const lines = [];
      for (const e of entries(filter)) {
        const d = new Date(e.t).toDateString();
        if (d !== day) { day = d; lines.push(`# ${d}`); }
        lines.push(`${time(e.t)}  [${e.kind}${e.mode === 'low' ? ', reasoning' : ''}]  ${e.text}${e.ms !== undefined ? `  (${e.ms} ms)` : ''}`);
      }
      return lines.join('\n');
    }

    return { add, clear, entries, toText, flush, time, isSpoken, MAX: MAX_ENTRIES, onAdd: (fn) => listeners.push(fn),
      get length() { return list.length; } };
  }

  const api = { createLog, MAX_ENTRIES, SAVE_DELAY_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    const log = createLog();
    // Save before the page goes away (tab closed, app switched, reload).
    root.addEventListener('pagehide', log.flush);
    root.addEventListener('visibilitychange', () => { if (root.document.hidden) log.flush(); });
    root.Log = log;
  }
})(this);
