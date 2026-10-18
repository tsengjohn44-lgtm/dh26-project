// recorder.js: end-of-speech detector on synthetic audio (pauses, clicks, background noise, no speech), trailing-silence trim.
const R = require(require('path').join(__dirname, '..', '..', 'public', 'recorder.js'));
const RATE = 48000, CH = 128;
let pass = 0, total = 0;
const check = (n, ok, d) => { total++; if (ok) pass++; console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : '  — ' + d}`); };
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
// segments: [ms, amplitude, kind] ; kind 'noise' or 'tone' (speech-like, with noise)
function run(segs, noise = 0.003) {
  const d = R.createSpeechDetector(RATE); const events = []; let t = 0;
  for (const [ms, amp] of segs) {
    const n = Math.round(ms / 1000 * RATE);
    for (let i = 0; i < n; i += CH) {
      const c = new Float32Array(Math.min(CH, n - i));
      for (let j = 0; j < c.length; j++) { const k = (t * RATE / 1000) + j; c[j] = amp * Math.sin(2 * Math.PI * 180 * k / RATE) * (0.6 + 0.4 * Math.sin(k / 900)) + noise * rnd(); }
      t += c.length / RATE * 1000;
      const ev = d.push(c); if (ev) events.push([ev, Math.round(t)]);
    }
  }
  return { events, d };
}
const at = (r, ev) => (r.events.find((e) => e[0] === ev) || [])[1];
{ const r = run([[500, 0], [1000, 0.2], [2000, 0]]);
  check('speech then silence ⇒ speech-start then silence ≈1.2 s after speech ends', at(r, 'speech-start') > 500 && at(r, 'silence') >= 2650 && at(r, 'silence') <= 2800, JSON.stringify(r.events)); }
{ const r = run([[400, 0], [800, 0.2], [600, 0], [800, 0.2], [2000, 0]]);
  check('0.6 s pause mid-question ⇒ no early end; ends after the second part', at(r, 'silence') > 3000, JSON.stringify(r.events)); }
{ const r = run([[7000, 0]]);
  check('noise only ⇒ no-speech at 6 s', at(r, 'no-speech') >= 6000 && at(r, 'no-speech') < 6100 && !at(r, 'speech-start'), JSON.stringify(r.events)); }
{ const r = run([[500, 0], [100, 0.5], [1000, 0], [100, 0.5], [5500, 0]]);
  check('100 ms clicks ⇒ not speech', !at(r, 'speech-start') && at(r, 'no-speech'), JSON.stringify(r.events)); }
{ const r = run([[500, 0], [1000, 0.25], [2000, 0]], 0.03);
  check('loud steady background (street) ⇒ speech still detected and ended', at(r, 'speech-start') && at(r, 'silence'), JSON.stringify(r.events)); }
{ const r = run([[500, 0], [1000, 0.012], [2000, 0]], 0.003);
  check('very quiet sound under MIN_LEVEL ⇒ not speech', !at(r, 'speech-start'), JSON.stringify(r.events)); }
{ const r = run([[500, 0], [1000, 0.2], [2000, 0]]);
  check('lastSpeechMs ≈ end of speech (1.5 s)', Math.abs(r.d.lastSpeechMs - 1500) < 60, r.d.lastSpeechMs);
  check('after silence: done, no further events', r.d.push(new Float32Array(CH).fill(0.5)) === null, ''); }
// trim through the live recorder with a fake AudioContext (ScriptProcessor path)
(async () => {
  let proc; const ctx = { state: 'running', sampleRate: RATE, destination: {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => ({ gain: {}, connect() {}, disconnect() {} }), createScriptProcessor: () => (proc = { connect() {}, disconnect() {} }) };
  Object.defineProperty(global, "navigator", { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true });
  const fired = [];
  await R.start(ctx, { onSilence: () => fired.push('silence'), onNoSpeech: () => fired.push('no') });
  const feed = (ms, amp) => { for (let i = 0; i < ms / 1000 * RATE; i += 4096) { const c = new Float32Array(4096); for (let j = 0; j < c.length; j++) c[j] = amp * Math.sin(j / 40) + 0.002 * rnd(); proc.onaudioprocess({ inputBuffer: { getChannelData: () => c } }); } };
  feed(500, 0); feed(1000, 0.2); feed(1400, 0);
  await Promise.resolve(); await Promise.resolve();
  check('live recorder: onSilence fired once', fired.join() === 'silence', fired.join());
  const rec = R.stop();
  check('trailing silence trimmed to ~0.3 s after speech (≈1.8 s total of 2.9 s)', rec && rec.seconds > 1.7 && rec.seconds < 2.0, rec && rec.seconds);
  await R.start(ctx, () => {}); feed(500, 0); const r2 = R.stop();
  check('bare function still accepted (onLimit); no speech ⇒ untrimmed', r2 && Math.abs(r2.seconds - 0.512) < 0.1, r2 && r2.seconds);
  console.log(`${pass}/${total}`);
})();
