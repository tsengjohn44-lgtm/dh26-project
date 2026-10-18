// ui.js + log.js in a fake DOM: the History sheet (open/close, filters, live rows, tap to hear, Copy, Clear, Show older).
const fs = require('fs'), vm = require('vm');
const UI = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'ui.js'), 'utf8');
const { createLog } = require(require('path').join(__dirname, '..', '..', 'public', 'log.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };
class Node {
  constructor(tag, id) { this.tagName = tag; this.id = id; this.children = []; this.parent = null; this.h = {}; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this._text = ''; this.className = '';
    const self = this; this.classList = { add: (c) => { const s = new Set(self.className.split(' ').filter(Boolean)); s.add(c); self.className = [...s].join(' '); }, remove: (c) => { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); }, contains: (c) => self.className.split(' ').includes(c), toggle() {} }; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; } get lastChild() { return this.children[this.children.length - 1] || null; }
  append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } } appendChild(c) { this.append(c); return c; }
  prepend(c) { c.parent = this; this.children.unshift(c); } replaceChildren(...n) { this.children = []; this.append(...n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.h[t] ||= []).push(f); } fire(t, ev = {}) { return Promise.all((this.h[t] || []).map((f) => f({ preventDefault() {}, target: this, ...ev }))); }
  focus() { focused = this.id; } closest() { return null; } select() {}
  querySelectorAll(sel) { return sel === '[data-filter]' ? filterBtns : []; }
}
let focused = null; let filterBtns = [];
function setup({ stored = [], filterPref = null, confirmAnswer = true, clipboard = true } = {}) {
  const els = {}; const ids = ['settingsBtn', 'historyBtn', 'sheet', 'logSheet', 'sheetBackdrop', 'sheetClose', 'logClose', 'current', 'reasoning', 'logList', 'logMore', 'logCount', 'logCopy', 'logClear', 'history'];
  for (const id of ids) els[id] = new Node('div', id);
  els.sheet.hidden = els.logSheet.hidden = els.sheetBackdrop.hidden = true;
  filterBtns = ['spoken', 'all'].map((f) => { const b = new Node('button', 'f-' + f); b.dataset.filter = f; return b; });
  const store = { replyLog: JSON.stringify(stored), ...(filterPref && { logFilter: filterPref }) };
  const storage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const Log = createLog({ storage, setTimer: () => 0 });
  const spoken = [], copied = [], docH = {};
  const body = new Node('body');
  const ctx = {
    document: { getElementById: (id) => els[id], querySelectorAll: (s) => (s === '.sheet' ? [els.sheet, els.logSheet] : []), createElement: (t) => new Node(t), addEventListener: (t, f) => { (docH[t] ||= []).push(f); }, body, execCommand: () => true },
    navigator: { ...(clipboard && { clipboard: { writeText: async (t) => { copied.push(t); } } }) },
    localStorage: storage, MutationObserver: class { observe() {} }, Event: class { constructor(t) { this.type = t; } }, setTimeout,
    Speech: { unlock() {}, say: (t) => spoken.push(t) }, Filter: require(require('path').join(__dirname, '..', '..', 'public', 'filter.js')), Log,
  };
  ctx.window = { Log, Speech: ctx.Speech, Filter: ctx.Filter, confirm: () => confirmAnswer };
  vm.createContext(ctx); vm.runInContext(UI, ctx);
  const rows = () => els.logList.children.filter((r) => !r.className.includes('log-empty'));
  const rowText = (r) => r.children[0].children[1].textContent;
  return { els, Log, spoken, copied, store, rows, rowText, key: (k) => (docH.keydown || []).forEach((f) => f({ key: k })), body };
}
const T = Date.UTC(2026, 9, 18, 12, 0, 0);
const sample = [{ t: T, kind: 'alert', text: 'Door on right.' }, { t: T + 1000, kind: 'n/a', text: 'n/a', ms: 480 }, { t: T + 2000, kind: 'alert', text: 'Trip hazard: curb close ahead.', ms: 512 },
  { t: T + 3000, kind: 'repeat', text: 'Curb ahead.' }, { t: T + 4000, kind: 'answer', text: 'No, stairs ahead.' }, { t: T + 5000, kind: 'error', text: 'Request timed out' }];
(async () => {
  { const u = setup({ stored: sample }); const { els } = u;
    els.historyBtn.fire('click');
    check('🕘 opens the History sheet, backdrop shown, focus on close', !els.logSheet.hidden && !els.sheetBackdrop.hidden && els.historyBtn.attrs['aria-expanded'] === 'true' && focused === 'logClose', `${els.logSheet.hidden} ${focused}`);
    const r = u.rows();
    check('default "Spoken": 3 rows, newest first (answer, curb, door)', r.length === 3 && u.rowText(r[0]) === 'No, stairs ahead.' && u.rowText(r[2]) === 'Door on right.', r.map(u.rowText).join(' | '));
    check('hazard row tagged "hazard" with the hazard class', r[1].className.includes('hazard') && r[1].children[0].children[0].children[1].textContent.startsWith('hazard'), r[1].className);
    check('row has a readable label (time, tag: text)', /^\d\d:\d\d:\d\d, answer: No, stairs ahead\.$/.test(r[0].children[0].attrs['aria-label']), r[0].children[0].attrs['aria-label']);
    check('count line', /3 spoken · 6 replies kept on this phone \(last 1000\)/.test(els.logCount.textContent), els.logCount.textContent);
    filterBtns[1].fire('click');
    const all = u.rows();
    check('"All replies": 6 rows, dropped ones dimmed, ms shown', all.length === 6 && all.filter((x) => x.className.includes('dim')).length === 3 && /480 ms/.test(all[4].textContent), all.map((x) => x.className).join(' | '));
    check('filter choice saved', u.store.logFilter === 'all' && filterBtns[1].attrs['aria-checked'] === 'true', u.store.logFilter);
    all[3].children[0].fire('click');
    check('tap a row → spoken again', u.spoken[0] === 'Trip hazard: curb close ahead.', JSON.stringify(u.spoken));
    u.Log.add({ kind: 'alert', text: 'Drop-off: stairs going down ahead, at least 3 steps.' });
    check('new reply appears at the top while open', u.rowText(u.rows()[0]).startsWith('Drop-off: stairs') && u.rows().length === 7, u.rowText(u.rows()[0]));
    await els.logCopy.fire('click');
    check('Copy puts the text log on the clipboard', u.copied.length === 1 && /\[alert\] {2}Door on right\./.test(u.copied[0]) && /\[n\/a\]/.test(u.copied[0]), u.copied[0]);
    u.key('Escape');
    check('Escape closes it; focus back on 🕘', els.logSheet.hidden && els.sheetBackdrop.hidden && focused === 'historyBtn', `${els.logSheet.hidden} ${focused}`);
    u.Log.add({ kind: 'alert', text: 'Not rendered while closed.' });
    check('closed: new replies are logged but not rendered', u.Log.length === 8 && !u.rows().some((x) => u.rowText(x) === 'Not rendered while closed.'), '');
    els.history.fire('click');
    check('tapping the faded lines under the alert opens History (up to date)', !els.logSheet.hidden && u.rowText(u.rows()[0]) === 'Not rendered while closed.', u.rowText(u.rows()[0]));
    els.settingsBtn.fire('click');
    check('opening Settings closes History (one sheet at a time)', els.logSheet.hidden && !els.sheet.hidden && !els.sheetBackdrop.hidden, `${els.logSheet.hidden} ${els.sheet.hidden}`);
    els.sheetBackdrop.fire('click');
    check('backdrop closes Settings as before', els.sheet.hidden && els.sheetBackdrop.hidden, '');
    els.historyBtn.fire('click'); els.logClear.fire('click');
    check('Clear (confirmed) empties the log and shows the empty message', u.Log.length === 0 && els.logList.children.length === 1 && /No replies yet/.test(els.logList.children[0].textContent), els.logList.textContent); }
  { const u = setup({ stored: sample, confirmAnswer: false });
    u.els.historyBtn.fire('click'); u.els.logClear.fire('click');
    check('Clear cancelled → nothing deleted', u.Log.length === 6, u.Log.length); }
  { const many = Array.from({ length: 700 }, (_, i) => ({ t: T + i, kind: 'alert', text: `alert ${i}` }));
    const u = setup({ stored: many, filterPref: 'all' });
    u.els.historyBtn.fire('click');
    check('restored "All" filter; renders 300 newest; "Show older" visible', u.rows().length === 300 && u.rowText(u.rows()[0]) === 'alert 699' && u.els.logMore.hidden === false && filterBtns[1].attrs['aria-checked'] === 'true', `${u.rows().length} ${u.els.logMore.hidden}`);
    u.els.logMore.fire('click'); u.els.logMore.fire('click');
    check('"Show older" ×2 → all 700, button hidden', u.rows().length === 700 && u.els.logMore.hidden === true, `${u.rows().length}`); }
  { const u = setup({ stored: sample, clipboard: false });
    u.els.historyBtn.fire('click'); await u.els.logCopy.fire('click');
    check('no clipboard API (plain HTTP) → textarea fallback, says Copied', u.els.logCopy.textContent === 'Copied', u.els.logCopy.textContent); }
  { const u = setup({});
    u.els.historyBtn.fire('click');
    check('empty log → "Nothing spoken yet. Tap Start."', /Nothing spoken yet/.test(u.els.logList.textContent), u.els.logList.textContent); }
  console.log(`${pass}/${total}`);
})();
