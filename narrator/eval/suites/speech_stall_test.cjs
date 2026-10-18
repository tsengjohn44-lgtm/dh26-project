// speech.js: a speech download that stops sending data is given up (STALL_MS shortened to 300 ms), so the queue drains.
const fs = require('fs'), vm = require('vm');
let src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'speech.js'), 'utf8').replace('const STALL_MS = 8000;', 'const STALL_MS = 300;'); // shorten for the test
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FakeCtx { constructor() { this.state = 'running'; this.destination = {}; } get currentTime() { return performance.now() / 1000; } resume() { return Promise.resolve(); }
  createBuffer(c, len, rate) { return { duration: len / rate, copyToChannel() {} }; } createBufferSource() { return { connect() {}, start() {}, stop() {}, set onended(f) { setTimeout(f, 10); } }; } }
const fetch = (url, opts) => new Promise((res, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); }); // hangs until aborted
const ctx = { window: { AudioContext: FakeCtx }, fetch, performance, setTimeout, clearTimeout, console, Promise, JSON, Error, String, Math, Number, DataView, Float32Array, Uint8Array, AbortController };
vm.createContext(ctx); vm.runInContext(src, ctx);
const Speech = ctx.window.Speech;
(async () => {
  Speech.unlock(); Speech.say('A'); await sleep(50);
  const during = Speech.pending;
  await sleep(1200); // 2 attempts x 300 ms stall + margin
  const ok = during === 1 && Speech.pending === 0 && /stalled/.test(Speech.stats.lastError);
  console.log(ok ? '✓ hung speech download is given up; queue drains (camera would resume)' : `✗ hung speech download is given up   pending ${during}->${Speech.pending} err ${Speech.stats.lastError}`);
  console.log(`${ok ? 1 : 0}/1`);
})();
