// Loads public/speech.js with fake fetch + Web Audio and checks ordering, no loss, and interrupt.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeEnv({ synthMs, playMs, failFirst = new Set() }) {
  const log = [], attempts = {};
  class FakeCtx {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createBuffer() { return { text: '' }; }
    decodeAudioData(bytes) { return Promise.resolve({ text: Buffer.from(bytes).toString() }); }
    createBufferSource() {
      const node = { connect() {}, onended: null, timer: null,
        start() { if (!this.buffer.text) return; log.push(`start ${this.buffer.text}`); this.timer = setTimeout(() => { log.push(`end ${this.buffer.text}`); this.onended && this.onended(); }, playMs); },
        stop() { clearTimeout(this.timer); log.push(`cut ${this.buffer.text}`); this.onended && this.onended(); } };
      return node;
    }
  }
  const window = { AudioContext: FakeCtx };
  const fetch = async (url, opts) => {
    const text = JSON.parse(opts.body).text;
    attempts[text] = (attempts[text] || 0) + 1;
    await sleep(synthMs(text));
    if (failFirst.has(text) && attempts[text] === 1) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(text) };
  };
  const ctx = { window, fetch, performance, setTimeout, clearTimeout, console, Promise, JSON, Error, String, Math };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { Speech: window.Speech, log, attempts };
}
(async () => {
  let pass = 0, total = 0;
  const check = (name, cond, detail) => { total++; pass += !!cond; console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}`); };

  // 1. Queue: A slow to generate, B and C fast. Must play A, B, C in order, none lost.
  { const { Speech, log } = makeEnv({ synthMs: (t) => ({ A: 300, B: 50, C: 80 })[t], playMs: 100 });
    Speech.unlock(); Speech.say('A'); await sleep(10); Speech.say('B'); Speech.say('C');
    await sleep(1000);
    const order = log.filter((l) => l.startsWith('start')).join(',');
    check('queue plays in order even when later clips generate first', order === 'start A,start B,start C', order);
    check('queue: no clip lost, none cut', !log.some((l) => l.startsWith('cut')) && log.filter((l) => l.startsWith('end')).length === 3, log.join(' | '));
    check('queue: pending back to 0', Speech.pending === 0, Speech.pending); }

  // 2. Prefetch: B is generated while A plays, so B starts right after A ends (no generation gap).
  { const { Speech, log } = makeEnv({ synthMs: () => 150, playMs: 400 });
    Speech.unlock(); const t0 = Date.now(); const times = {};
    const orig = log.push.bind(log); log.push = (x) => { times[x] = Date.now() - t0; return orig(x); };
    Speech.say('A'); Speech.say('B');
    await sleep(1200);
    const gap = times['start B'] - times['end A'];
    check('prefetch: next clip starts immediately after previous ends', gap < 30, `gap ${gap} ms`); }

  // 3. Interrupt: B cuts off A while it plays; C (queued during B's generation) cuts B's pending clip.
  { const { Speech, log } = makeEnv({ synthMs: () => 50, playMs: 500 });
    Speech.unlock(); Speech.interrupt = true;
    Speech.say('A'); await sleep(150);          // A playing
    Speech.say('B'); await sleep(20);           // B generating, A must be cut now
    Speech.say('C');                            // B dropped before playing
    await sleep(800);
    const seq = log.join(',');
    check('interrupt: current clip cut immediately', log.includes('cut A') && log.indexOf('cut A') < log.indexOf('start C'), seq);
    check('interrupt: only the newest pending clip plays', !log.includes('start B') && log.includes('start C') && log.includes('end C'), seq); }

  // 4. Retry: a clip whose first generation fails is retried and still played.
  { const { Speech, log, attempts } = makeEnv({ synthMs: () => 30, playMs: 50, failFirst: new Set(['A']) });
    Speech.unlock(); Speech.say('A'); Speech.say('B');
    await sleep(500);
    check('retry: failed clip retried once and played, order kept', attempts.A === 2 && log.filter((l) => l.startsWith('start')).join(',') === 'start A,start B', `${attempts.A} attempts; ${log.join(',')}`); }

  // 5. Cancel (Stop button): everything stops, nothing plays afterwards.
  { const { Speech, log } = makeEnv({ synthMs: () => 100, playMs: 300 });
    Speech.unlock(); Speech.say('A'); Speech.say('B'); await sleep(150); Speech.cancel(); await sleep(600);
    check('cancel: A cut, B never plays', log.includes('cut A') && !log.includes('start B') && Speech.pending === 0, log.join(',')); }

  // 6. Disabled voice: say() does nothing.
  { const { Speech, log } = makeEnv({ synthMs: () => 10, playMs: 10 });
    Speech.unlock(); Speech.enabled = false; Speech.say('A'); await sleep(100);
    check('voice off: nothing generated or played', log.length === 0, log.join(',')); }

  console.log(`${pass}/${total}`);
})();
