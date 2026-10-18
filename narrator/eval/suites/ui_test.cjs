// ui.js in a fake DOM: settings sheet open/close and focus, Reasoning segmented control, tap to repeat, hazard highlight, vibration.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'ui.js'), 'utf8');
function setup({ reasoningValue = 'none', vibrate = true } = {}) {
  const docHandlers = {}; const observers = []; let focused = null;
  function el(id, extra = {}) {
    const h = {};
    const e = { id, hidden: false, style: {}, dataset: {}, attrs: {}, value: '', classes: new Set(), offsetWidth: 1,
      classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), toggle: (c, on) => (on ? e.classes.add(c) : e.classes.delete(c)), contains: (c) => e.classes.has(c) },
      setAttribute(k, v) { e.attrs[k] = String(v); if (k === 'data-alert') { e.dataset.alert = v; observers.forEach((o) => o()); } },
      getAttribute: (k) => e.attrs[k],
      addEventListener(t, f) { (h[t] ||= []).push(f); }, fire(t, ev = {}) { (h[t] || []).forEach((f) => f({ preventDefault() {}, target: e, ...ev })); },
      dispatchEvent(ev) { e.dispatched = (e.dispatched || []).concat(ev.type); (h[ev.type] || []).forEach((f) => f(ev)); },
      focus() { focused = id; }, closest: () => null, querySelectorAll: () => extra.grips || [], ...extra };
    return e;
  }
  const els = {};
  for (const id of ['settingsBtn', 'sheetBackdrop', 'sheetClose', 'current']) els[id] = el(id);
  els.sheet = el('sheet', { grips: [el('handle'), el('head')] }); els.sheet.hidden = true; els.sheetBackdrop.hidden = true;
  els.reasoning = el('reasoning'); els.reasoning.value = reasoningValue;
  const segs = ['none', 'hybrid', 'low', 'high'].map((v) => { const b = el('seg-' + v); b.dataset.value = v; return b; });
  // the card: setting dataset.alert happens via app.js -> emulate with setAlert()
  const spoken = [];
  const ctx = {
    document: { getElementById: (id) => els[id], querySelectorAll: () => segs, addEventListener: (t, f) => { (docHandlers[t] ||= []).push(f); } },
    navigator: vibrate ? { vibrate: (ms) => { ctx.vibrations = (ctx.vibrations || 0) + 1; } } : {},
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() { observers.push(() => this.cb([])); } },
    Event: class { constructor(type) { this.type = type; } },
    window: { Filter: require(require('path').join(__dirname, '..', '..', 'public', 'filter.js')) }, Speech: { unlock() {}, say: (t) => spoken.push(t) },
  };
  ctx.window.Speech = ctx.Speech; ctx.Filter = ctx.window.Filter;
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const setAlert = (t) => { els.current.dataset.alert = t; observers.forEach((o) => o()); };
  return { els, segs, spoken, ctx, setAlert, focused: () => focused, key: (k) => (docHandlers.keydown || []).forEach((f) => f({ key: k })) };
}
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };

{ const u = setup(); const { els } = u;
  els.settingsBtn.fire('click');
  check('⚙ opens the settings sheet, aria-expanded true, focus moves in', !els.sheet.hidden && !els.sheetBackdrop.hidden && els.settingsBtn.attrs['aria-expanded'] === 'true' && u.focused() === 'sheetClose', JSON.stringify(els.settingsBtn.attrs));
  els.sheetClose.fire('click');
  check('✕ closes it, focus returns to ⚙', els.sheet.hidden && els.sheetBackdrop.hidden && els.settingsBtn.attrs['aria-expanded'] === 'false' && u.focused() === 'settingsBtn', '');
  els.settingsBtn.fire('click'); els.sheetBackdrop.fire('click');
  check('tapping the backdrop closes it', els.sheet.hidden, '');
  els.settingsBtn.fire('click'); u.key('Escape');
  check('Escape closes it', els.sheet.hidden, '');
}
{ const u = setup({ reasoningValue: 'hybrid' });
  check('segmented control shows the restored choice (Fast + Low)', u.segs.find((b) => b.dataset.value === 'hybrid').attrs['aria-checked'] === 'true' && u.segs.filter((b) => b.attrs['aria-checked'] === 'true').length === 1, JSON.stringify(u.segs.map((b) => b.attrs)));
  u.segs.find((b) => b.dataset.value === 'high').fire('click');
  check('tapping "High" sets the select and fires change (app.js saves it)', u.els.reasoning.value === 'high' && (u.els.reasoning.dispatched || []).includes('change') && u.segs.find((b) => b.dataset.value === 'high').attrs['aria-checked'] === 'true', `${u.els.reasoning.value} ${u.els.reasoning.dispatched}`);
}
{ const u = setup();
  u.els.current.fire('click');
  check('tap on card with no alert yet: nothing spoken', u.spoken.length === 0, JSON.stringify(u.spoken));
  u.setAlert('Stairs going down ahead, at least 6 steps.');
  u.els.current.fire('click');
  check('tap on card repeats the alert', u.spoken[0] === 'Stairs going down ahead, at least 6 steps.', JSON.stringify(u.spoken));
  u.els.current.fire('keydown', { key: 'Enter' });
  check('Enter on the focused card repeats too (keyboard / screen reader)', u.spoken.length === 2, JSON.stringify(u.spoken));
  check('stairs alert → hazard highlight + vibration + arrival animation', u.els.current.classes.has('hazard') && u.ctx.vibrations === 1 && u.els.current.classes.has('fresh'), `${[...u.els.current.classes]} vib ${u.ctx.vibrations}`);
  u.setAlert('Door ahead, sign reads "Lobby".');
  check('door alert → no hazard highlight, vibrates for the new alert', !u.els.current.classes.has('hazard') && u.ctx.vibrations === 2, `${[...u.els.current.classes]} vib ${u.ctx.vibrations}`);
  u.setAlert('Door ahead, sign reads "Lobby".');
  check('same alert again → no extra vibration', u.ctx.vibrations === 2, `vib ${u.ctx.vibrations}`);
}
{ const u = setup({ vibrate: false }); u.setAlert('Curb close ahead.');
  check('no vibration support (iPhone) → no error, hazard still shown', u.els.current.classes.has('hazard'), [...u.els.current.classes].join(','));
}
{ const u = setup(); u.setAlert('Head hazard: low branch at head height, ahead.');
  check('"Head hazard: …" gets the hazard edge', u.els.current.classes.has('hazard'), [...u.els.current.classes].join(','));
  u.setAlert('Obstacle: bin, ahead.');
  check('"Obstacle: …" gets the hazard edge', u.els.current.classes.has('hazard'), [...u.els.current.classes].join(','));
  u.setAlert('Door ahead, sign reads "Lobby".');
  check('door alert has no hazard edge', !u.els.current.classes.has('hazard'), [...u.els.current.classes].join(',')); }
console.log(`${pass}/${total}`);
