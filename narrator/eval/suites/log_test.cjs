// log.js (History): debounced saves, flush on hide, reload, 1,000 cap, filters, clear, corrupt or blocked storage. Fake storage and timers.
const { createLog, MAX_ENTRIES } = require(require('path').join(__dirname, '..', '..', 'public', 'log.js'));
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };
const memStore = (init = {}) => { const m = { ...init }; return { m, writes: 0, getItem: (k) => m[k] ?? null, setItem(k, v) { this.writes++; m[k] = v; }, removeItem: (k) => { delete m[k]; } }; };
const fakeTimers = () => { const q = []; return { q, set: (f) => { q.push(f); return q.length; }, run: () => { while (q.length) q.shift()(); } }; };
{ const st = memStore(), tm = fakeTimers(); let t = Date.UTC(2026, 9, 18, 12, 0, 0);
  const L = createLog({ storage: st, setTimer: tm.set, now: () => t++ });
  for (let i = 0; i < 5; i++) L.add({ kind: 'alert', text: `a${i}`, ms: 512.4 });
  check('5 quick adds → one save scheduled, nothing written yet', tm.q.length === 1 && st.writes === 0, `${tm.q.length} ${st.writes}`);
  tm.run();
  check('debounced save writes once with all 5', st.writes === 1 && JSON.parse(st.m.replyLog).length === 5, `${st.writes}`);
  check('entry shape {t, kind, text, ms rounded}', JSON.stringify(Object.keys(L.entries()[0])) === '["t","kind","text","ms"]' && L.entries()[0].ms === 512, JSON.stringify(L.entries()[0]));
  L.add({ kind: 'repeat', text: '  Curb   ahead. ' }); L.add({ kind: 'bogus', text: 'x' }); L.add({ kind: 'correction', text: 'Arrow right', mode: 'low' });
  check('unknown kinds ignored; whitespace collapsed; mode kept', L.length === 7 && L.entries()[5].text === 'Curb ahead.' && L.entries()[6].mode === 'low', JSON.stringify(L.entries().slice(5)));
  check('spoken filter: alert/correction only (not repeat)', L.entries('spoken').length === 6, L.entries('spoken').length);
  L.flush();
  check('flush (pagehide) saves pending entries', JSON.parse(st.m.replyLog).length === 7, '');
  const L2 = createLog({ storage: st, setTimer: tm.set });
  check('reload restores the log', L2.length === 7 && L2.entries()[6].text === 'Arrow right', L2.length);
  const txt = L.toText();
  check('toText: date header, time, kind, text, ms', /^# .*2026/.test(txt) && /\d\d:\d\d:\d\d {2}\[alert\] {2}a0 {2}\(512 ms\)/.test(txt) && /\[correction, reasoning\]/.test(txt), txt.split('\n').slice(0, 2).join(' | '));
  check('toText spoken omits repeats', !/Curb ahead/.test(L.toText('spoken')) && /Curb ahead/.test(L.toText('all')), '');
  let seen = null; L.onAdd((e) => { seen = e; }); L.add({ kind: 'answer', text: 'No, stairs ahead.' });
  check('onAdd listeners get each new entry', seen && seen.kind === 'answer', JSON.stringify(seen));
  L.clear();
  check('clear empties memory and storage', L.length === 0 && st.m.replyLog === undefined, `${L.length} ${st.m.replyLog}`); }
{ const st = memStore(), tm = fakeTimers(); const L = createLog({ storage: st, setTimer: tm.set });
  for (let i = 0; i < MAX_ENTRIES + 250; i++) L.add({ kind: 'n/a', text: `r${i}` });
  tm.run();
  check(`capped at ${MAX_ENTRIES}, oldest dropped`, L.length === MAX_ENTRIES && L.entries()[0].text === 'r250' && JSON.parse(st.m.replyLog).length === MAX_ENTRIES, `${L.length} ${L.entries()[0].text}`);
  check(`1000 entries ≈ ${Math.round(st.m.replyLog.length / 1024)} KB stored`, st.m.replyLog.length < 200 * 1024, st.m.replyLog.length); }
{ const L = createLog({ storage: memStore({ replyLog: '{not json' }), setTimer: () => 0 });
  check('corrupt stored data → empty log, no crash', L.length === 0, L.length);
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };
  const B = createLog({ storage: blocked, setTimer: (f) => { f(); return 1; } });
  B.add({ kind: 'alert', text: 'still works' }); B.clear(); B.add({ kind: 'alert', text: 'again' });
  check('blocked storage (private mode): works in memory, no throw', B.length === 1, B.length);
  const M = createLog({ storage: memStore({ replyLog: JSON.stringify([{ t: 1, kind: 'alert', text: 'ok' }, { kind: 'alert' }, null, { t: 2, kind: 'zzz', text: 'bad' }]) }), setTimer: () => 0 });
  check('malformed stored entries are skipped', M.length === 1 && M.entries()[0].text === 'ok', JSON.stringify(M.entries())); }
console.log(`${pass}/${total}`);
