// The real public/app.js in a fake browser (camera, screen, sensors, fetch, audio): camera races, orientation/flip, blur gate,
// reasoning modes, Fast + Low, Ask, distance sensor in requests, pause while speaking, History logging.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function env({ coarse = true, gumMs = 50, debugQuery = '', lockFails = false, ua = 'Mozilla/5.0 (Linux; Android 14) EdgA/130', answer = null, saved = {}, answerFn = null, recorder = {} } = {}) {
  const scene = { pixels: null, transforms: [] };
  const streams = [], calls = { fullscreen: 0, lock: [], unlock: 0, exitFs: 0, gum: 0 };
  const listeners = {};
  function el(id) {
    const handlers = {};
    const e = { id, textContent: '', style: {}, dataset: {}, checked: id === 'voice' || id === 'safetyLabels', value: id === 'reasoning' ? 'none' : '400', children: [],
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      addEventListener(t, f) { (handlers[t] ||= []).push(f); }, fire(t, ev = {}) { (handlers[t] || []).forEach((f) => f(ev)); },
      contains(x) { return x === e; }, attrs: {}, setAttribute(k, v) { e.attrs[k] = v; }, prepend(c) { e.children.unshift(c); }, get lastChild() { return { remove: () => e.children.pop() }; },
      getContext: () => ({ drawImage() {}, setTransform(...a) { scene.transforms.push(a.join(',')); }, getImageData: (x, y, w, h) => ({ data: (w === 160 ? scene.sharpPixels : scene.pixels) || new Uint8ClampedArray((w || 24) * (h || 18) * 4) }) }), toDataURL: () => 'data:image/jpeg;base64,AAAA',
      play: () => Promise.resolve(), width: 0, height: 0, srcObject: null };
    Object.defineProperty(e, 'videoWidth', { get: () => (e.srcObject ? 640 : 0) });
    Object.defineProperty(e, 'videoHeight', { get: () => (e.srcObject ? 480 : 0) });
    return e;
  }
  const els = {};
  const document = {
    fullscreenElement: null, documentElement: { requestFullscreen: () => { calls.fullscreen++; document.fullscreenElement = {}; return Promise.resolve(); } },
    exitFullscreen: () => { calls.exitFs++; document.fullscreenElement = null; return Promise.resolve(); },
    getElementById: (id) => (els[id] ||= el(id)), createElement: (t) => el(t), hidden: false,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  };
  const orientationHandlers = [];
  const screen = { orientation: { angle: 0, lock: (o) => { calls.lock.push(o); return lockFails ? Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotSupportedError' })) : Promise.resolve(); }, unlock: () => { calls.unlock++; }, addEventListener: (t, f) => orientationHandlers.push(f) } };
  const navigator = { userAgent: ua, mediaDevices: {
    getUserMedia: async () => { calls.gum++; await sleep(gumMs); const tracks = [{ live: true, stop() { this.live = false; }, getSettings: () => ({ width: 640, height: 480 }), getCapabilities: () => ({}), label: 'Back camera', clone() { return { stop() {} }; } }];
      const s = { getTracks: () => tracks, getVideoTracks: () => tracks }; streams.push(s); return s; },
    enumerateDevices: async () => [] }, wakeLock: { request: async () => ({ release: async () => {} }) } };
  let describeCalls = 0, lastBody = null;
  const bodies = []; let slowOpen = 0, slowMax = 0;
  const asks = []; let askReply = null;
  const fetch = (url, opts) => { if (url === '/api/ask') { const b = JSON.parse(opts.body); asks.push(b); if (askReply) return sleep(30).then(askReply); return sleep(30).then(() => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Drop-off: stairs going down ahead.' })); } describeCalls++; lastBody = opts && opts.body ? JSON.parse(opts.body) : null; bodies.push(lastBody);
    if (answerFn) { const a = answerFn(lastBody); const slow = lastBody.reasoning === 'low'; if (slow) { slowOpen++; slowMax = Math.max(slowMax, slowOpen); }
      return sleep(a.delayMs).then(() => { if (slow) slowOpen--; return { ok: !a.status, status: a.status || 200, headers: { get: () => null }, text: async () => a.text }; }); }
    return answer === null ? new Promise(() => {}) : sleep(30).then(() => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => answer })); };
  const spoken = [], spokenOpts = []; const Speech = { unlock() {}, cancel() {}, say(t, opts) { spoken.push(t); spokenOpts.push({ t, urgent: !!(opts && opts.urgent) }); }, stats: {}, pending: 0, enabled: true, interrupt: false, set onChange(f) {} };
  const beeperLog = []; const Beeper = { reading: null, state: 'offline', start() { beeperLog.push('start'); }, stop() { beeperLog.push('stop'); }, enabled: true, volume: 0.6, intensity: 1, onChangeFn: null, set onChange(f) { this.onChangeFn = f; } };
  const winHandlers = {};
  const winObj = { addEventListener: (t, f) => { (winHandlers[t] ||= []).push(f); }, fire: (t, ev) => (winHandlers[t] || []).forEach((f) => f(ev)) };
  const frameRot = { value: 0 };
  class fakeMSTP { constructor() { this.readable = { getReader: () => ({ read: async () => { await sleep(20); return { done: false, value: { rotation: frameRot.value, flip: false, codedWidth: 640, codedHeight: 480, displayWidth: 640, displayHeight: 480, close() {} } }; }, cancel: async () => {} }) }; } }
  const store = { ...saved };
  const recLog = []; let recording = false; const recOpts = {};
  const Recorder = { get recording() { return recording; },
    start: async (c, o) => { recLog.push('start'); if (recorder.deny) throw new Error('Permission denied'); recording = true; recOpts.value = o; },
    stop: () => { recLog.push('stop'); recording = false; return recorder.tooShort ? null : { audio: 'UklGRg'.padEnd(400, 'A'), seconds: 2 }; },
    cancel: () => { recLog.push('cancel'); recording = false; } };
  const Log = require(require('path').join(__dirname, '..', '..', 'public', 'log.js')).createLog({ storage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimer: () => 0 });
  const ctx = { Log, document, screen, navigator, fetch, Speech, Beeper, Recorder, Filter: require(require('path').join(__dirname, '..', '..', 'public', 'filter.js')), console, setTimeout, clearTimeout, performance, Promise, Math, Number, JSON, Error, String, Float32Array, Uint8ClampedArray, AbortController,
    matchMedia: (q) => ({ matches: coarse && q.includes('coarse') }), localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, window: winObj, MediaStreamTrackProcessor: fakeMSTP, location: { search: debugQuery }, setInterval, clearInterval, URLSearchParams };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const live = () => streams.filter((s) => s.getTracks().some((t) => t.live)).length;
  const get = (expr) => vm.runInContext(expr, ctx);
  const turn = (angle) => { screen.orientation.angle = angle; orientationHandlers.forEach((f) => f()); };
  return { Log: ctx.Log, ctx, recOpts, setAsk: (f) => { askReply = f; }, calls, live, get, turn, els, document, listeners, winObj, frameRot, store, scene, describes: () => describeCalls, asks, recLog, lastBody: () => lastBody, bodies, spokenOpts, slowMax: () => slowMax, beeperLog, Beeper, spoken, Speech };
}
(async () => {
  let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };

  { const e = env({ gumMs: 200 });
    e.ctx.start(); await sleep(50); e.ctx.stop(); await sleep(400);
    check('Stop while the camera is opening: no camera left on, app not running', e.live() === 0 && e.get('running') === false && e.get('stream') === null, `live ${e.live()}, running ${e.get('running')}`); }

  { const e = env({ gumMs: 100 });
    await e.ctx.start(); e.ctx.reopenCamera(); e.ctx.reopenCamera(); await sleep(600);
    check('two overlapping reopens leave exactly one camera on', e.live() === 1 && e.get('stream') !== null, `live ${e.live()}`); }

  { const e = env({ gumMs: 30 });
    await e.ctx.start(); e.turn(90); await sleep(150); const gumAfter90 = e.calls.gum; const view1 = e.get('viewId');
    e.turn(270); await sleep(150);
    check('0→90 turn: no camera reopen', gumAfter90 === 1, `gum calls ${gumAfter90}`);
    check('90→270 turn while running: one reopen + view reset, one camera on', e.calls.gum === 2 && e.get('viewId') === view1 + 1 && e.live() === 1, `gum ${e.calls.gum}, view ${view1}->${e.get('viewId')}, live ${e.live()}`);
    e.ctx.stop(); e.turn(90); await sleep(100);
    check('180° turn while stopped: nothing reopened', e.calls.gum === 2 && e.live() === 0, `gum ${e.calls.gum}, live ${e.live()}`); }

  { const e = env({ gumMs: 300 });
    const p = e.ctx.start(); await sleep(10);
    check('grabFrame returns null while no camera is attached', e.ctx.grabFrame() === null, 'got a frame');
    await p; check('grabFrame returns a frame once the camera is on', typeof e.ctx.grabFrame() === 'string', 'null'); e.ctx.stop(); }

  { const e = env({ coarse: true, gumMs: 10 });
    await e.ctx.start(); await sleep(20);
    check('phone: Start enters fullscreen and locks portrait-primary', e.calls.fullscreen === 1 && e.calls.lock[0] === 'portrait-primary', JSON.stringify(e.calls));
    e.document.fullscreenElement = null; // e.g. permission prompt or back swipe left fullscreen
    e.listeners.click.forEach((f) => f({ target: {} })); await sleep(10);
    check('phone: next tap after leaving fullscreen locks again', e.calls.fullscreen === 2 && e.calls.lock.length === 2, JSON.stringify(e.calls));
    e.document.fullscreenElement = null;
    e.listeners.click.forEach((f) => f({ target: e.els.start })); await sleep(10);
    check('phone: tapping Start/Stop does not trigger the re-lock', e.calls.fullscreen === 2, JSON.stringify(e.calls));
    e.document.fullscreenElement = {};
    e.ctx.stop();
    check('phone: Stop unlocks and exits fullscreen', e.calls.unlock === 1 && e.calls.exitFs === 1, JSON.stringify(e.calls)); }

  { const e = env({ coarse: false, gumMs: 10 });
    await e.ctx.start(); await sleep(20); e.listeners.click.forEach((f) => f({ target: {} }));
    check('desktop: no fullscreen or lock', e.calls.fullscreen === 0 && e.calls.lock.length === 0, JSON.stringify(e.calls)); e.ctx.stop(); }

  { const e = env({ gumMs: 20 });
    await e.ctx.start(); e.ctx.screen.orientation.angle = 180; await sleep(700); // turned over, no event fired
    check('180° turn with no event: caught by the 500 ms poll, camera reopened', e.calls.gum === 2 && e.live() === 1, `gum ${e.calls.gum}, live ${e.live()}`); e.ctx.stop(); }

  { const e = env({ gumMs: 10, lockFails: true, debugQuery: '?debug' });
    await e.ctx.start(); await sleep(30);
    const text = e.els.debugText.textContent;
    check('?debug: overlay shows build, angle and the lock failure reason', !e.els.debug.hidden && /version flip-fix-1/.test(text) && /lock failed: NotSupportedError: not allowed/.test(text) && /screen .* 0°/.test(text), text); e.ctx.stop(); }

  { const e = env({ gumMs: 10 });
    await e.ctx.start(); await sleep(30);
    check('no ?debug: overlay never shown (stays hidden in HTML)', !e.els.debug || e.els.debug.hidden !== false, String(e.els.debug && e.els.debug.hidden)); e.ctx.stop(); }

  { const e = env({ gumMs: 10 });
    check('page loads with overlay hidden by default', e.els.debug.hidden === true, String(e.els.debug.hidden));
    e.els.debugBtn.fire('click');
    check('🐞 button shows the overlay and remembers it', e.els.debug.hidden === false && e.store.debug === '1' && e.els.debugBtn.attrs['aria-pressed'] === 'true', `${e.els.debug.hidden} ${e.store.debug}`);
    await e.ctx.start(); await sleep(150);
    e.frameRot.value = 180; await sleep(400);
    e.winObj.fire('devicemotion', { accelerationIncludingGravity: { x: 0.1, y: 9.7, z: 0.5 } });
    e.winObj.fire('devicemotion', { accelerationIncludingGravity: { x: 0.2, y: 0.3, z: 9.8 } });
    e.ctx.renderDiag(); const t = e.els.debugText.textContent;
    check('overlay logs camera frame rotation change 0° → 180°', /camera frame rotation 0°, flip false → 180°, flip false/.test(t), t);
    check('overlay describes how the phone is held (upright → flat)', /phone now flat, screen up/.test(t) && /phone held: flat, screen up/.test(t), t);
    check('overlay shows the frame sent to the AI', String(e.els.debugFrame.src).startsWith('data:image/jpeg'), String(e.els.debugFrame.src));
    e.els.debugBtn.fire('click');
    check('🐞 again hides the overlay', e.els.debug.hidden === true && e.store.debug === '0', `${e.els.debug.hidden} ${e.store.debug}`);
    e.ctx.stop(); }

  { const e = env({ gumMs: 10 });
    check('re-lock no longer uses pointerdown (no activation on touch)', !(e.listeners.pointerdown || []).length && (e.listeners.click || []).length === 1, Object.keys(e.listeners).join(','));
    await e.ctx.start(); await sleep(30);
    const g = (x, y, z = 9) => e.winObj.fire('devicemotion', { accelerationIncludingGravity: { x, y, z } });
    const tf = () => e.els.video.style.transform || '';
    g(0.2, 2.0); check('upright-ish (y +2): no correction', !tf().includes('rotate'), tf());
    g(0.1, -0.3); check('top just below level (y -0.3, inside the gap): still no correction', !tf().includes('rotate'), tf());
    g(0.1, -1.5); check('top edge dipped (y -1.5): preview turned 180°', tf().includes('rotate(180deg)'), tf());
    e.scene.transforms.length = 0; e.ctx.grabFrame();
    check('frame sent to AI is turned back (canvas rotated 180°)', e.scene.transforms[0]?.startsWith('-1,0,0,-1'), e.scene.transforms.join(' | '));
    g(0.1, 0.3); check('back to y +0.3 (inside the gap): correction stays on', tf().includes('rotate(180deg)'), tf());
    g(3, -1); check('on its side (|x| > |y|): unchanged', tf().includes('rotate(180deg)'), tf());
    g(0.2, 3.0); check('lifted upright (y +3): correction off, preview normal', !tf().includes('rotate'), tf());
    e.scene.transforms.length = 0; e.ctx.grabFrame();
    check('frame sent to AI not turned when upright', !e.scene.transforms.some((t) => t.startsWith('-1')), e.scene.transforms.join(' | '));
    e.ctx.stop(); }

  { const e = env({ gumMs: 10, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari' });
    await e.ctx.start(); await sleep(30);
    e.winObj.fire('devicemotion', { accelerationIncludingGravity: { x: 0, y: -5, z: 8 } });
    check('iPhone: correction never applied', !(e.els.video.style.transform || '').includes('rotate'), e.els.video.style.transform);
    e.ctx.stop(); }

  { const e = env({ gumMs: 10, debugQuery: '?debug' });
    const img = new Uint8ClampedArray(24 * 18 * 4); for (let i = 0; i < 24 * 18; i++) { const v = (i * 37) % 251; img.set([v, v, v, 255], i * 4); }
    const flipped = new Uint8ClampedArray(img.length); for (let i = 0; i < 24 * 18; i++) flipped.set(img.subarray((24 * 18 - 1 - i) * 4, (24 * 18 - i) * 4), i * 4);
    e.scene.pixels = img; await e.ctx.start(); await sleep(30);
    e.ctx.grabFrame(); e.ctx.grabFrame();
    check('detector: no flip logged for an unchanged picture', !/turned image 180/.test(e.els.debugText.textContent || ''), e.els.debugText.textContent);
    e.scene.pixels = flipped; e.ctx.grabFrame(); e.ctx.renderDiag();
    check('detector: browser half-turn seen in the picture is logged', /browser turned image 180° \(seen in picture\)/.test(e.els.debugText.textContent), e.els.debugText.textContent);
    e.ctx.stop(); }

  { const e = env({ gumMs: 10 }); e.ctx.Speech.pending = 1; // an alert is being spoken
    await e.ctx.start(); await sleep(1200);
    check('while audio is playing: no frames sent, status says paused', e.describes() === 0 && /paused while speaking/.test(e.els.status.textContent), `${e.describes()} sent, status "${e.els.status.textContent}"`);
    e.ctx.Speech.pending = 0; await sleep(600);
    check('audio finished: frames are sent again', e.describes() > 0, `${e.describes()} sent`);
    e.ctx.stop(); }
  { const e = env({ gumMs: 10 }); e.ctx.Speech.pending = 1; e.ctx.Speech.enabled = false;
    await e.ctx.start(); await sleep(600);
    check('voice turned off: never paused', e.describes() > 0, `${e.describes()} sent`); e.ctx.stop(); }

  { const e = env({ gumMs: 10 });
    await e.ctx.start(); await sleep(30); e.ctx.stop();
    check('Start starts the beeper, Stop stops it', e.beeperLog.join(',') === 'stop,start,stop' || e.beeperLog.join(',') === 'start,stop', e.beeperLog.join(','));
    check('beeper defaults: on, 60% volume, 1× intensity', e.Beeper.enabled === true && Math.abs(e.Beeper.volume - 0.6) < 1e-9 && e.Beeper.intensity === 1, JSON.stringify(e.Beeper));
    e.els.beepVolume.value = '25'; e.els.beepVolume.fire('input'); e.els.beepIntensity.value = '1.7'; e.els.beepIntensity.fire('input');
    e.els.beeps.checked = false; e.els.beeps.fire('change');
    check('sliders/toggle drive the beeper', Math.abs(e.Beeper.volume - 0.25) < 1e-9 && e.Beeper.intensity === 1.7 && e.Beeper.enabled === false, JSON.stringify(e.Beeper));
    check('settings saved on the device', e.store.beepVolume === '25' && e.store.beepIntensity === '1.7' && e.store.beeps === '0', JSON.stringify(e.store));
    e.Beeper.onChangeFn('0.42'); const chip1 = e.els.distance.textContent; e.Beeper.onChangeFn('offline'); const chip2 = e.els.distance.textContent; e.Beeper.onChangeFn('clear');
    check('distance chip: "obstacle 0.42 m", "sensor offline", "sensor: clear"', chip1 === 'obstacle 0.42 m' && chip2 === 'sensor offline' && e.els.distance.textContent === 'sensor: clear', `${chip1} | ${chip2} | ${e.els.distance.textContent}`); }

  {
    // 160x120 test scene: sharp = deterministic noise; blurry = the same scene box-blurred.
    const W = 160, H = 120, base = new Float32Array(W * H); let seed = 7;
    for (let i = 0; i < base.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; base[i] = 60 + (seed % 140); }
    const blurred = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let t = 0, n = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); t += base[yy * W + xx]; n++; } blurred[y * W + x] = t / n; }
    const rgba = (g) => { const d = new Uint8ClampedArray(g.length * 4); g.forEach((v, i) => d.set([v, v, v, 255], i * 4)); return d; };
    const SHARP = rgba(base), BLURRY = rgba(blurred);
    const thumbPx = new Uint8ClampedArray(24 * 18 * 4); for (let i = 0; i < 24 * 18; i++) thumbPx.set([i % 200, i % 200, i % 200, 255], i * 4);

    { const e = env({ gumMs: 10, answer: 'n/a', debugQuery: '?debug' }); e.scene.pixels = thumbPx; e.scene.sharpPixels = SHARP;
      await e.ctx.start(); await sleep(2200);
      const sentSharp = e.describes();
      check('blur: steady sharp frames are sent', sentSharp >= 4 && e.get('blurStats.verdict') === 'sharp', `${sentSharp} sent, verdict ${e.get('blurStats.verdict')}`);
      e.scene.sharpPixels = BLURRY; const t0 = Date.now(); await sleep(1000);
      const skipped1s = e.get('blurStats.skipped');
      check('blur: blurry frames are not sent (first 1 s)', e.describes() === sentSharp, `${e.describes() - sentSharp} sent`);
      check('blur: re-checked about every 100 ms (not every 400 ms)', skipped1s >= 6, `${skipped1s} checks in 1 s`);
      check('blur: status says hold steady', /hold steady/.test(e.els.status.textContent), e.els.status.textContent);
      await sleep(1300);
      check('blur: after 2 s with nothing sharp, exactly one (the sharpest) frame is sent', e.describes() === sentSharp + 1, `${e.describes() - sentSharp} sent`);
      await sleep(1500);
      check('blur: after 3 s of blur, "Hold the phone steady." is spoken once', e.spoken.filter((t) => t === 'Hold the phone steady.').length === 1, JSON.stringify(e.spoken));
      await sleep(3000);
      check('blur: hint not repeated within 15 s', e.spoken.filter((t) => t === 'Hold the phone steady.').length === 1, JSON.stringify(e.spoken));
      check('blur: hint logged in History as "hint"', e.Log.entries().filter((x) => x.kind === 'hint').length === 1, JSON.stringify(e.Log.entries().map((x) => x.kind)));
      check('blur: hint is not added to the "already said" list', !e.get('said').includes('Hold the phone steady.'), JSON.stringify(e.get('said')));
      check('blur: overlay shows sharpness and skips', /blur: .*sharpness .* skipped \d+/.test((e.ctx.renderDiag(), e.els.debugText.textContent)), e.els.debugText.textContent);
      e.scene.sharpPixels = SHARP; const before = e.describes(); await sleep(900);
      check('blur: sharp again → frames sent again', e.describes() > before && e.get('blurStats.verdict') === 'sharp', `${e.describes() - before} sent`);
      e.ctx.stop(); }

    { const e = env({ gumMs: 10, answer: 'n/a' }); e.scene.pixels = thumbPx; e.scene.sharpPixels = SHARP; e.ctx.Speech.enabled = false;
      await e.ctx.start(); await sleep(1800); e.scene.sharpPixels = BLURRY; await sleep(3600);
      check('blur: no spoken hint when Voice is off', e.spoken.length === 0, JSON.stringify(e.spoken)); e.ctx.stop(); }

    { const e = env({ gumMs: 10, answer: 'n/a' }); e.scene.pixels = thumbPx; e.scene.sharpPixels = SHARP;
      await e.ctx.start(); await sleep(600); const n = e.describes();
      e.winObj.fire('devicemotion', { rotationRate: { alpha: 150, beta: 20, gamma: 10 } }); await sleep(900);
      check('blur: phone turning fast (>90°/s) → skipped even if the score looks sharp', e.describes() === n && /moving/.test(e.get('blurStats.verdict')), `${e.describes() - n} sent, ${e.get('blurStats.verdict')}`);
      e.winObj.fire('devicemotion', { rotationRate: { alpha: 5, beta: 2, gamma: 1 } }); await sleep(600);
      check('blur: phone steady again → sent', e.describes() > n, `${e.describes() - n} sent`); e.ctx.stop(); }

    { const e = env({ gumMs: 10, answer: 'n/a' }); e.scene.pixels = thumbPx; e.scene.sharpPixels = BLURRY;
      await e.ctx.start(); await sleep(1000);
      check('blur: a new view starts with no reference, so its first frames are sent (no false skips)', e.describes() >= 2, `${e.describes()} sent`); e.ctx.stop(); }
  }

  { const e = env({ gumMs: 10 });
    check('Pause while speaking: on by default', e.els.pauseSpeaking.checked === true && e.get('pauseWhileSpeaking') === true, String(e.els.pauseSpeaking.checked));
    e.els.pauseSpeaking.checked = false; e.els.pauseSpeaking.fire('change');
    e.ctx.Speech.pending = 1; await e.ctx.start(); await sleep(900);
    check('Pause while speaking OFF: frames keep going while the voice talks', e.describes() > 0 && !/paused while speaking/.test(e.els.status.textContent), `${e.describes()} sent, status ${e.els.status.textContent}`);
    check('Pause while speaking: setting saved on the device', e.store.pauseWhileSpeaking === '0', JSON.stringify(e.store));
    e.els.pauseSpeaking.checked = true; e.els.pauseSpeaking.fire('change'); const n = e.describes(); await sleep(900);
    check('Pause while speaking ON again: no new frames while speaking', e.describes() === n, `${e.describes() - n} sent`);
    e.ctx.stop(); }

  { const e = env({ gumMs: 10 });
    check('Reasoning selector defaults to Off', e.els.reasoning.value === 'none', e.els.reasoning.value);
    await e.ctx.start(); await sleep(500);
    check('Off → request asks for reasoning "none"', e.lastBody()?.reasoning === 'none', JSON.stringify(e.lastBody() && e.lastBody().reasoning));
    e.ctx.stop(); e.els.reasoning.value = 'high'; e.els.reasoning.fire('change');
    check('choice is saved on the device', e.store.reasoning === 'high', JSON.stringify(e.store));
    await e.ctx.start(); await sleep(500);
    check('High → request asks for reasoning "high"', e.lastBody()?.reasoning === 'high', JSON.stringify(e.lastBody() && e.lastBody().reasoning));
    e.ctx.stop(); }
  { const e = env({ gumMs: 10, saved: { reasoning: 'low' } });
    check('saved Reasoning choice restored on a fresh page load', e.els.reasoning.value === 'low', e.els.reasoning.value); }
  { const e = env({ gumMs: 10, saved: { reasoning: 'garbage' } });
    check('invalid saved value ignored (stays Off)', e.els.reasoning.value === 'none', e.els.reasoning.value); }

  {
    const L = 'Door ahead. Sign: Class Room 71A, 71B, 71F, 71G, arrow left.', R = 'Door ahead. Sign: Class Room 71A, 71B, 71F, 71G, arrow right.';
    { const e = env({ gumMs: 10, saved: { reasoning: 'hybrid' }, answerFn: (b) => b.reasoning === 'low' ? { text: R, delayMs: 1200 } : { text: L, delayMs: 30 } });
      check('Fast + Low: saved choice restored', e.els.reasoning.value === 'hybrid', e.els.reasoning.value);
      await e.ctx.start(); await sleep(2600); e.ctx.stop();
      const kinds = e.bodies.map((b) => b.reasoning);
      check('Fast + Low: each frame sent fast (none) and slow (low)', kinds.includes('none') && kinds.includes('low') && !kinds.includes('hybrid'), kinds.join(','));
      check('Fast + Low: at most 2 slow requests in flight', e.slowMax() <= 2 && e.slowMax() >= 1, String(e.slowMax()));
      const said = e.spoken;
      check('Fast + Low: fast alert spoken first, then the slow correction (arrow right), each once', said[0] === L && said.filter((t) => t === R).length === 1 && said.indexOf(R) > 0, JSON.stringify(said));
      check('Fast + Low: slow reply used although newer fast replies arrived first', e.get('slowStats.spoken') === 1, JSON.stringify(e.get('slowStats'))); }

    { const e = env({ gumMs: 10, saved: { reasoning: 'hybrid' }, answerFn: (b) => ({ text: L, delayMs: b.reasoning === 'low' ? 900 : 30 }) });
      await e.ctx.start(); await sleep(2200); e.ctx.stop();
      check('Fast + Low: slow reply identical to the fast one is suppressed (not spoken twice)', e.spoken.filter((t) => t === L).length === 1 && e.get('slowStats.suppressed') >= 1, `${JSON.stringify(e.spoken)} ${JSON.stringify(e.get('slowStats'))}`); }

    { const e = env({ gumMs: 10, saved: { reasoning: 'hybrid' }, answerFn: (b) => b.reasoning === 'low' ? { text: R, delayMs: 800 } : { text: 'n/a', delayMs: 30 } });
      await e.ctx.start(); await sleep(150); e.ctx.resetView(); await sleep(250); e.ctx.resetView(); await sleep(250); e.ctx.resetView();
      await sleep(1100); const spokenEarly = e.spoken.length; const stale = e.get('slowStats.stale');
      e.ctx.stop();
      check('Fast + Low: slow reply for an older view is ignored', stale >= 1, `stale ${stale}, spoken ${spokenEarly}`); }

    { const e = env({ gumMs: 10, answerFn: (b) => ({ text: 'n/a', delayMs: 30 }) });
      await e.ctx.start(); await sleep(900); e.ctx.stop();
      check('Off (default): no slow requests at all', e.bodies.every((b) => b.reasoning === 'none'), e.bodies.map((b) => b.reasoning).join(',')); }
  }

  { const answers = ['Door ahead, sign reads "Lobby".', 'Trip hazard: curb close ahead.'];
    let i = 0; const e = env({ gumMs: 10, answerFn: () => ({ text: answers[Math.min(i++, 1)], delayMs: 20 }) });
    e.ctx.Speech.enabled = false; e.ctx.Speech.pending = 0;
    await e.ctx.start(); await sleep(1200); e.ctx.stop();
    const door = e.spokenOpts.find((x) => x.t.startsWith('Door')), trip = e.spokenOpts.find((x) => x.t.startsWith('Trip hazard'));
    check('labelled hazard alert is spoken as urgent; a door alert is not', door && trip && trip.urgent === true && door.urgent === false, JSON.stringify(e.spokenOpts)); }

  { const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    check('Safety labels on by default → requests ask for style "safety"', e.els.safetyLabels.checked === true, String(e.els.safetyLabels.checked));
    await e.ctx.start(); await sleep(500); const first = e.lastBody(); e.ctx.stop();
    e.els.safetyLabels.checked = false; e.els.safetyLabels.fire('change');
    await e.ctx.start(); await sleep(500); const second = e.lastBody(); e.ctx.stop();
    check('switched off → style "classic", saved on the device', first.style === 'safety' && second.style === 'classic' && e.store.safetyLabels === '0', `${first.style} ${second.style} ${e.store.safetyLabels}`); }
  { const e = env({ gumMs: 10, saved: { safetyLabels: '0', reasoning: 'hybrid' }, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(600); e.ctx.stop();
    check('saved "off" restored; Fast + Low reasoning requests use classic too', e.els.safetyLabels.checked === false && e.bodies.length > 1 && e.bodies.every((b) => b.style === 'classic'), JSON.stringify(e.bodies.map((b) => b.reasoning + ':' + b.style))); }

  { // not running yet
    const e = env({ gumMs: 10 });
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(50); e.els.ask.fire('pointerup');
    check('Ask before Start: tells the user to tap Start first, no recording', /Tap Start first/.test(e.els.status.textContent) && e.recLog.length === 0, `${e.els.status.textContent} ${e.recLog}`); }
  { // hold to talk
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(300);
    e.ctx.Beeper.enabled = true;
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(50);
    const describesAtStart = e.describes();
    check('hold: recording starts, speech cancelled, beeps muted, status Listening', e.recLog[0] === 'start' && e.ctx.Beeper.enabled === false && /Listening/.test(e.els.status.textContent), `${e.recLog} beeper ${e.ctx.Beeper.enabled} ${e.els.status.textContent}`);
    await sleep(600);
    check('hold: no frames sent to /api/describe while recording', e.describes() === describesAtStart, `${e.describes() - describesAtStart} sent`);
    e.els.ask.fire('pointerup'); await sleep(200);
    const a = e.asks[0];
    check('release: /api/ask gets the current frame + WAV audio + reasoning level', a && a.image.startsWith('data:image/jpeg') && a.audio.startsWith('UklGRg') && a.reasoning === 'none', JSON.stringify(a && { image: a.image.slice(0, 20), audio: a.audio.slice(0, 8), reasoning: a.reasoning }));
    const last = e.spokenOpts[e.spokenOpts.length - 1];
    check('answer shown, spoken as urgent, not added to "already said"', e.els.current.textContent === 'Drop-off: stairs going down ahead.' && last && last.t === 'Drop-off: stairs going down ahead.' && last.urgent === true && !e.get('said').includes('Drop-off: stairs going down ahead.'), `${e.els.current.textContent} ${JSON.stringify(last)} ${JSON.stringify(e.get('said'))}`);
    check('after the answer: beeps restored, narration resumes', e.ctx.Beeper.enabled === true && e.get('asking') === false, `${e.ctx.Beeper.enabled} ${e.get('asking')}`);
    const before = e.describes(); await sleep(700);
    check('narration frames flow again after asking', e.describes() > before, `${e.describes() - before}`);
    e.ctx.stop(); }
  { // quick tap toggles: tap to start, tap again to send
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(30); e.els.ask.fire('pointerup'); await sleep(300);
    check('quick tap: keeps recording (toggle mode), nothing sent yet', e.get('Recorder.recording') === true && e.asks.length === 0, `${e.get('Recorder.recording')} ${e.asks.length}`);
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(30); e.els.ask.fire('pointerup'); await sleep(200);
    check('second tap: sends the question', e.asks.length === 1 && e.get('Recorder.recording') === false, `${e.asks.length}`);
    e.ctx.stop(); }
  { // keyboard / screen reader click without pointer events
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(100);
    check('click (no press) starts recording', e.get('Recorder.recording') === true, String(e.get('Recorder.recording')));
    e.els.ask.fire('click'); await sleep(200);
    check('second click sends', e.asks.length === 1, String(e.asks.length)); e.ctx.stop(); }
  { const e = env({ gumMs: 10, recorder: { tooShort: true }, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(50); e.els.ask.fire('click'); await sleep(100);
    check('too-short recording: nothing sent, hint shown, narration resumes', e.asks.length === 0 && /Too short/.test(e.els.status.textContent) && e.get('asking') === false, `${e.asks.length} ${e.els.status.textContent}`); e.ctx.stop(); }
  { const e = env({ gumMs: 10, recorder: { deny: true }, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(100);
    check('microphone denied: error shown, not stuck in asking', /Microphone/.test(e.els.status.textContent) && e.get('asking') === false && e.ctx.Beeper.enabled !== false, `${e.els.status.textContent} ${e.get('asking')}`); e.ctx.stop(); }
  { const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200); e.els.ask.fire('click'); await sleep(50); e.ctx.stop();
    check('Stop while recording: microphone released', e.recLog.includes('cancel') && e.get('asking') === false, e.recLog.join(',')); }

  { // distance reading in AI requests
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    check('Share distance with AI: default on, height default 1 m', e.els.sensorToAi.checked === true && Number(e.els.sensorHeight.value) === 1, `${e.els.sensorToAi.checked} ${e.els.sensorHeight.value}`);
    e.Beeper.reading = { metres: 0.8537, ageMs: 120 };
    e.els.sensorHeight.value = '1.25'; e.els.sensorHeight.fire('input');
    await e.ctx.start(); await sleep(300);
    check('valid reading → describe body has sensor {distanceM, heightM}', JSON.stringify(e.lastBody().sensor) === '{"distanceM":0.85,"heightM":1.25}', JSON.stringify(e.lastBody().sensor));
    check('height saved', e.store.sensorHeight === '1.25', e.store.sensorHeight);
    e.Beeper.reading = null; await sleep(500);
    check('no valid reading (offline / out of range / stale) → no sensor field', e.lastBody().sensor === undefined, JSON.stringify(e.lastBody().sensor));
    e.Beeper.reading = { metres: 2, ageMs: 10 }; e.els.sensorToAi.checked = false; e.els.sensorToAi.fire('change'); await sleep(500);
    check('toggle off → no sensor field, saved off', e.lastBody().sensor === undefined && e.store.sensorToAi === '0', `${JSON.stringify(e.lastBody().sensor)} ${e.store.sensorToAi}`);
    e.els.sensorToAi.checked = true; e.els.sensorToAi.fire('change');
    e.els.reasoning.value = 'hybrid'; e.els.reasoning.fire('change'); await sleep(600);
    const slow = e.bodies.filter((b) => b.reasoning === 'low').pop();
    check('Fast + Low: slow request carries the same sensor reading', slow && slow.sensor && slow.sensor.distanceM === 2, JSON.stringify(slow && slow.sensor));
    e.els.reasoning.value = 'none'; e.els.reasoning.fire('change');
    e.els.ask.fire('click'); await sleep(100); e.els.ask.fire('click'); await sleep(200);
    check('Ask: request carries the sensor reading', e.asks[0] && e.asks[0].sensor && e.asks[0].sensor.distanceM === 2, JSON.stringify(e.asks[0] && e.asks[0].sensor));
    e.ctx.stop(); }
  { const e = env({ gumMs: 10, saved: { sensorToAi: '0', sensorHeight: '0.8' }, debugQuery: '?debug', answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    check('saved settings restored (off, 0.8 m)', e.els.sensorToAi.checked === false && Number(e.els.sensorHeight.value) === 0.8 && e.els.sensorHeightOut.textContent === '0.80 m', `${e.els.sensorToAi.checked} ${e.els.sensorHeight.value} ${e.els.sensorHeightOut.textContent}`);
    e.els.sensorToAi.checked = true; e.Beeper.reading = { metres: 1.5, ageMs: 10 };
    await e.ctx.start(); await sleep(700);
    check('🐞 overlay shows what is sent', /sensor→AI: 1\.50 m @ 0\.80 m high/.test(e.els.debugText.textContent), (e.els.debugText.textContent.match(/sensor→AI.*/) || [''])[0]);
    e.ctx.stop(); }
  { // History log (log.js): every reply and what was done with it
    let n = 0;
    const replies = ['Door on right.', 'Door on right.', 'n/a', 'Trip hazard: curb close ahead.'];
    const e = env({ gumMs: 10, answerFn: () => { const i = n++; return i === 4 ? { text: 'slow and stale', delayMs: 900 } : { text: replies[Math.min(i, 3)] || 'n/a', delayMs: 40 }; } });
    await e.ctx.start(); await sleep(3200);
    const kinds = e.Log.entries().map((x) => x.kind);
    check('History: shown alert logged as "alert" with time taken', e.Log.entries().some((x) => x.kind === 'alert' && x.text === 'Door on right.' && x.ms > 0), JSON.stringify(e.Log.entries().slice(0, 3)));
    check('History: restatement logged as "repeat", n/a as "n/a"', kinds.includes('repeat') && kinds.includes('n/a'), kinds.join(','));
    check('History: reply overtaken by a newer frame logged as "late"', e.Log.entries().some((x) => x.kind === 'late' && x.text === 'slow and stale'), kinds.join(','));
    check('History: spoken filter = exactly the alerts shown', JSON.stringify(e.Log.entries('spoken').map((x) => x.text)) === JSON.stringify(['Door on right.', 'Trip hazard: curb close ahead.']), JSON.stringify(e.Log.entries('spoken').map((x) => x.text)));
    e.ctx.stop(); }
  { const e = env({ gumMs: 10, answerFn: (b) => (b.reasoning === 'low' ? { text: 'Sign: arrow right.', delayMs: 120 } : { text: 'Sign: arrow left.', delayMs: 30 }) });
    e.els.reasoning.value = 'hybrid'; e.els.reasoning.fire('change');
    await e.ctx.start(); await sleep(900);
    const low = e.Log.entries().filter((x) => x.mode === 'low');
    check('History: Fast + Low correction logged as "correction" (mode low), duplicates as repeat/late', low.some((x) => x.kind === 'correction' && x.text === 'Sign: arrow right.') && low.some((x) => x.kind !== 'correction'), JSON.stringify(low.map((x) => x.kind)));
    e.ctx.stop(); }
  { const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(100); e.els.ask.fire('click'); await sleep(200);
    check('History: question answer logged as "answer"', e.Log.entries().some((x) => x.kind === 'answer' && x.text === 'Drop-off: stairs going down ahead.'), JSON.stringify(e.Log.entries().filter((x) => x.kind !== 'n/a')));
    e.ctx.stop(); }
  { const e = env({ gumMs: 10, answerFn: () => ({ text: 'upstream error fetch failed', delayMs: 20, status: 502 }) });
    await e.ctx.start(); await sleep(300);
    check('History: request error logged as "error"', e.Log.entries().some((x) => x.kind === 'error' && /upstream error/.test(x.text)), JSON.stringify(e.Log.entries()));
    e.ctx.stop(); }
  { // tap once, speak, stop talking -> sent automatically
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(30); e.els.ask.fire('pointerup'); await sleep(100);
    check('tap: recorder gets onSilence / onNoSpeech / onLimit callbacks', ['onSilence', 'onNoSpeech', 'onLimit'].every((k) => typeof (e.recOpts.value || {})[k] === 'function'), Object.keys(e.recOpts.value || {}).join(','));
    check('tap: status asks for the question', /Listening… ask your question/.test(e.els.status.textContent), e.els.status.textContent);
    e.recOpts.value.onSilence(); await sleep(200);
    check('silence after speech: question sent with no second tap', e.asks.length === 1 && e.get('Recorder.recording') === false && e.get('asking') === false, `${e.asks.length} ${e.get('asking')}`);
    e.ctx.stop(); }
  { // holding: a pause doesn't send; release does
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('pointerdown', { preventDefault() {} }); await sleep(500);
    e.recOpts.value.onSilence(); e.recOpts.value.onNoSpeech(); await sleep(100);
    check('held: silence and no-speech ignored, still recording', e.asks.length === 0 && e.get('Recorder.recording') === true, `${e.asks.length} ${e.get('Recorder.recording')}`);
    e.els.ask.fire('pointerup'); await sleep(200);
    check('held: release sends', e.asks.length === 1, String(e.asks.length)); e.ctx.stop(); }
  { // nothing said
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(100);
    e.recOpts.value.onNoSpeech(); await sleep(100);
    check("no speech: nothing sent, mic released, \"Didn't hear a question\", beeps back", e.asks.length === 0 && e.recLog.includes('cancel') && /Didn't hear/.test(e.els.status.textContent) && e.get('asking') === false && e.ctx.Beeper.enabled !== false, `${e.asks.length} ${e.recLog} ${e.els.status.textContent}`);
    e.ctx.stop(); }
  { // stale server
    const e = env({ gumMs: 10, answerFn: () => ({ text: 'n/a', delayMs: 20 }) });
    e.setAsk(() => ({ ok: false, status: 405, headers: { get: () => null }, text: async () => 'Method not allowed' }));
    await e.ctx.start(); await sleep(200);
    e.els.ask.fire('click'); await sleep(100); e.els.ask.fire('click'); await sleep(70);
    check('405 from /api/ask: says to restart the server', /restart node server\.js/.test(e.els.current.textContent) && e.get('asking') === false, e.els.current.textContent);
    e.ctx.stop(); }

  console.log(`${pass}/${total}`);
  process.exit(0);
})();
