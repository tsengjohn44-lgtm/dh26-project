// beeper.js: beep curve and intensity, lookahead scheduler on a fake audio clock, ducking, stale/offline sensor, Beeper.reading for the AI.
const { beepParams, createBeeper } = require(require('path').join(__dirname, '..', '..', 'public', 'beeper.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };

// ---- curve ----
check('silent beyond 2 m', beepParams(2.01) === null && beepParams(3.9) === null, JSON.stringify(beepParams(2.01)));
check('silent when out of range (null)', beepParams(null) === null, '');
const ds = []; for (let d = 2.0; d > 0.1; d -= 0.05) ds.push(+d.toFixed(2));
const ps = ds.map((d) => beepParams(d));
check('interval shrinks monotonically from 2 m to 10 cm', ps.every((p, i) => i === 0 || p.interval <= ps[i - 1].interval), ps.map((p) => p.interval.toFixed(2)).join(' '));
check('loudness grows monotonically from 2 m to 10 cm', ps.every((p, i) => i === 0 || p.gain >= ps[i - 1].gain), ps.map((p) => p.gain.toFixed(2)).join(' '));
const at2 = beepParams(2.0), at1 = beepParams(1.0), at05 = beepParams(0.5), at01 = beepParams(0.1), at005 = beepParams(0.05);
check('2 m: faint (3%) and slow (1.2 s)', Math.abs(at2.gain - 0.03) < 1e-9 && Math.abs(at2.interval - 1.2) < 1e-9, JSON.stringify(at2));
check('≤10 cm: fast (0.08 s), full, urgent', at01.urgent && at005.urgent && at01.interval === 0.08 && at01.gain === 1, JSON.stringify(at01));
check('far range stays quiet: 1 m below 20% loudness', at1.gain < 0.2, at1.gain.toFixed(3));
const c = (2 - 1) / 1.9, p = c * c;
check('1× matches the formulas at 1 m', Math.abs(at1.interval - 1.2 * Math.pow(0.08 / 1.2, p)) < 1e-12 && Math.abs(at1.gain - (0.03 + 0.97 * p ** 1.5)) < 1e-12, JSON.stringify(at1));
const hi = beepParams(1.0, 2), lo = beepParams(1.0, 0.5);
check('intensity 2× is louder and faster than 1× at 1 m; 0.5× quieter and slower', hi.gain > at1.gain && hi.interval < at1.interval && lo.gain < at1.gain && lo.interval > at1.interval, `${JSON.stringify(lo)} ${JSON.stringify(at1)} ${JSON.stringify(hi)}`);
console.log('   sample curve (1×):', [2, 1.5, 1, 0.5, 0.25, 0.1].map((d) => { const q = beepParams(d); return `${d} m: every ${q.interval.toFixed(2)} s, ${(q.gain * 100).toFixed(0)}%, ${q.freq.toFixed(0)} Hz`; }).join(' | '));

// ---- scheduler with a fake audio clock and fake sensor stream ----
function fakeEnv() {
  const t0 = Date.now(); const beeps = []; let level = 0;
  const param = (onSet) => ({ value: 0, setValueAtTime(v) { onSet && onSet(v); }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v) { onSet && onSet(v); }, cancelScheduledValues() {} });
  const ctx = { get currentTime() { return (Date.now() - t0) / 1000; }, destination: {},
    createGain() { const g = { context: ctx, connect() {} }; g.gain = param((v) => { if (g.isMaster) level = v; }); return g; },
    createOscillator() { const o = { type: '', connect() {}, frequency: param(), start(t) { beeps.push({ t, freq: o.f }); }, stop() {} }; o.frequency.setValueAtTime = (v) => { o.f = v; }; return o; } };
  const origCreateGain = ctx.createGain; let first = true;
  ctx.createGain = () => { const g = origCreateGain(); if (first) { g.isMaster = true; first = false; } return g; };
  let es; class FakeES { constructor() { es = this; } close() { this.closed = true; } }
  const send = (metres, ageMs) => es.onmessage({ data: JSON.stringify({ metres, ...(ageMs && { ageMs }) }) });
  let speaking = false;
  const b = createBeeper({ getContext: () => ctx, isSpeaking: () => speaking, EventSourceImpl: FakeES });
  return { b, beeps, send, level: () => level, setSpeaking: (v) => { speaking = v; }, es: () => es };
}
const gaps = (beeps) => beeps.slice(1).map((x, i) => x.t - beeps[i].t);
(async () => {
  { const e = fakeEnv(); e.b.start(); e.send(0.5); const iv = setInterval(() => e.send(0.5), 200);
    await sleep(1500); clearInterval(iv); e.b.stop();
    const g = gaps(e.beeps), want = beepParams(0.5).interval;
    check(`beat spacing matches the curve at 0.5 m (${want.toFixed(3)} s)`, g.length >= 3 && g.every((x) => Math.abs(x - want) < 0.005), g.map((x) => x.toFixed(3)).join(' ')); }
  { const e = fakeEnv(); e.b.start(); e.send(1.5); const iv = setInterval(() => e.send(1.5), 200); await sleep(700);
    clearInterval(iv); const n = e.beeps.length; e.send(0.08); const iv2 = setInterval(() => e.send(0.08), 200); await sleep(400); clearInterval(iv2); e.b.stop();
    const after = e.beeps.slice(n); const first = after[0];
    check('getting close speeds up immediately (no wait for the old 1 s+ gap)', first && after.length >= 4 && gaps(after).every((x) => Math.abs(x - 0.08) < 0.005), JSON.stringify(gaps(after))); }
  { const e = fakeEnv(); e.b.start(); e.send(0.5); e.b.tick(); const normal = e.level();
    e.setSpeaking(true); e.b.tick(); const ducked = e.level();
    e.send(0.08); e.b.tick(); const urgentWhileSpeaking = e.level(); e.b.stop();
    check('ducks to 30% while the voice speaks', Math.abs(ducked - normal * 0.3) < 1e-9 && normal > 0, `${normal} -> ${ducked}`);
    check('never ducked at ≤10 cm', Math.abs(urgentWhileSpeaking - normal) < 1e-9, `${urgentWhileSpeaking}`); }
  { const e = fakeEnv(); e.b.start(); e.send(0.5); await sleep(1700); e.b.tick();
    const n = e.beeps.length; await sleep(600);
    check('no reading for 1.5 s: silent, state "offline"', e.beeps.length === n && e.level() === 0 && e.b.state === 'offline', `${n}->${e.beeps.length} state ${e.b.state}`); e.b.stop(); }
  { const e = fakeEnv(); e.b.start(); e.send(0.5, 60000); e.b.tick();
    check('replayed old reading (ageMs 60 s) is treated as stale', e.b.state === 'offline' && e.beeps.length === 0, e.b.state); e.b.stop(); }
  { const e = fakeEnv(); e.b.start(); e.send(null); const iv = setInterval(() => e.send(null), 200); await sleep(500); clearInterval(iv);
    check('Out_of_Range: silent, state "clear"', e.beeps.length === 0 && e.b.state === 'clear', `${e.beeps.length} ${e.b.state}`); e.b.stop(); }
  { const e = fakeEnv(); e.b.start(); e.send(0.3); const iv = setInterval(() => e.send(0.3), 200); await sleep(300);
    e.b.enabled = false; const n = e.beeps.length; await sleep(500);
    check('Beeps toggle off: no new beeps, muted', e.beeps.length === n && e.level() === 0, `${n}->${e.beeps.length}`);
    e.b.enabled = true; await sleep(400); clearInterval(iv);
    check('Beeps toggle on again: beeping resumes', e.beeps.length > n, `${e.beeps.length}`);
    e.b.stop(); const m = e.beeps.length; await sleep(400);
    check('Stop: stream closed, no further beeps', e.es().closed && e.beeps.length === m && e.level() === 0, `${e.es().closed} ${m}->${e.beeps.length}`); }
  { const e = fakeEnv(); e.b.start(); e.b.volume = 0.25; e.send(0.5); e.b.tick();
    check('volume slider scales the level', Math.abs(e.level() - 0.25) < 1e-9, e.level()); e.b.stop(); }
  { const e = fakeEnv(); e.b.start();
    const r0 = e.b.reading; e.send(0.85); const r1 = e.b.reading; e.send(null); const r2 = e.b.reading;
    e.send(4.3); const r3 = e.b.reading; e.send(0.5, 60000); const r4 = e.b.reading; e.send(0.5); e.b.enabled = false; const r5 = e.b.reading; e.b.stop();
    check('reading: null before any reading', r0 === null, JSON.stringify(r0));
    check('reading: fresh valid measurement → {metres, ageMs}', r1 && r1.metres === 0.85 && r1.ageMs < 100, JSON.stringify(r1));
    check('reading: Out_of_Range (null) → null', r2 === null, JSON.stringify(r2));
    check('reading: beyond 4 m → null', r3 === null, JSON.stringify(r3));
    check('reading: stale (60 s old) → null', r4 === null, JSON.stringify(r4));
    check('reading: still available with beeps muted', r5 && r5.metres === 0.5, JSON.stringify(r5)); }
  { const e = fakeEnv(); e.b.start(); e.send(0.7); await sleep(1600);
    check('reading: no new reading for 1.5 s → null', e.b.reading === null, JSON.stringify(e.b.reading)); e.b.stop(); }
  console.log(`${pass}/${total}`); process.exit(0);
})();
