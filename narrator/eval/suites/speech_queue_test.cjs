// speech.js (streaming PCM) with fake fetch streams and a fake Web Audio clock.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'speech.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each fake clip: `text` -> PCM whose samples encode the clip's letter; duration from durMs.
function makeEnv({ firstMs, chunkGapMs = 20, durMs, chunks = 4, failFirst = new Set(), oddSplit = false }) {
  const t0 = Date.now(), log = [], attempts = {}, RATE = 1000;
  class FakeCtx {
    constructor() { this.state = 'running'; this.destination = {}; }
    get currentTime() { return (Date.now() - t0) / 1000; }
    resume() { return Promise.resolve(); }
    createBuffer(ch, len, rate) { const data = new Float32Array(len); return { duration: len / rate, data, copyToChannel(d) { data.set(d); } }; }
    createBufferSource() {
      const ctx = this;
      return { connect() {}, onended: null, timers: [],
        start(when = 0) { const label = this.buffer.data.length > 1 ? String.fromCharCode(Math.round(this.buffer.data[0] * 32768)) : null;
          const delay = Math.max(0, when - ctx.currentTime) * 1000;
          this.timers.push(setTimeout(() => { if (label) log.push(`play ${label} @${Date.now() - t0}`); }, delay));
          this.timers.push(setTimeout(() => { if (label) log.push(`done ${label} @${Date.now() - t0}`); this.onended && this.onended(); }, delay + this.buffer.duration * 1000)); },
        stop() { this.timers.forEach(clearTimeout); log.push('stop'); } };
    }
  }
  const window = { AudioContext: FakeCtx };
  const fetch = async (url, opts) => {
    const text = JSON.parse(opts.body).text; attempts[text] = (attempts[text] || 0) + 1;
    await sleep(firstMs(text));
    if (opts.signal?.aborted) throw new Error('aborted');
    if (failFirst.has(text) && attempts[text] === 1) return { ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } };
    const total = Math.round(durMs(text) / 1000 * RATE), per = Math.ceil(total / chunks);
    const pcm = new Uint8Array(total * 2); const v = new DataView(pcm.buffer); for (let i = 0; i < total; i++) v.setInt16(i * 2, text.charCodeAt(0), true);
    let pos = 0; const step = oddSplit ? per * 2 + 1 : per * 2;
    return { ok: true, status: 200, headers: { get: (h) => (h === 'x-sample-rate' ? String(RATE) : null) },
      body: { getReader: () => ({ read: async () => { if (pos >= pcm.length) return { done: true }; if (pos) await sleep(chunkGapMs); const c = pcm.slice(pos, pos + step); pos += step; return { done: false, value: c }; } }) } };
  };
  const ctx = { window, fetch, performance, setTimeout, clearTimeout, console, Promise, JSON, Error, String, Math, Number, DataView, Float32Array, Uint8Array, AbortController };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { Speech: window.Speech, log, attempts, t0 };
}
const plays = (log) => log.filter((l) => l.startsWith('play')).map((l) => l.split(' ')[1]);
const firstPlay = (log, c) => Number(log.find((l) => l.startsWith(`play ${c}`))?.split('@')[1]);
const lastDone = (log, c) => Number([...log].reverse().find((l) => l.startsWith(`done ${c}`))?.split('@')[1]);
(async () => {
  let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };

  { // Streaming: playback starts on the first chunk, well before the download finishes.
    const { Speech, log } = makeEnv({ firstMs: () => 100, chunkGapMs: 150, durMs: () => 1000, chunks: 4 });
    Speech.unlock(); Speech.say('A'); await sleep(1600);
    const start = firstPlay(log, 'A');
    check('streaming: audio starts ~first chunk (100 ms + 50 ms headroom), not after full download (~550 ms)', start < 250, `started at ${start} ms`);
    check('streaming: delay stat recorded', Speech.stats.delayMs > 0 && Speech.stats.delayMs < 250, Speech.stats.delayMs);
    const gaps = log.filter((l) => l.startsWith('play A')).length;
    check('streaming: all chunks played', gaps === 4, gaps);
  }
  { // Queue order with out-of-order generation; none lost.
    const { Speech, log } = makeEnv({ firstMs: (t) => ({ A: 300, B: 30, C: 60 })[t], durMs: () => 200 });
    Speech.unlock(); Speech.say('A'); await sleep(5); Speech.say('B'); Speech.say('C'); await sleep(1500);
    const order = [...new Set(plays(log))].join('');
    check('queue: plays A, B, C in order although B and C were ready first', order === 'ABC', order);
    check('queue: clips do not overlap', firstPlay(log, 'B') >= lastDone(log, 'A') - 5 && firstPlay(log, 'C') >= lastDone(log, 'B') - 5, log.join(' '));
    check('queue: next clip starts right after previous (prefetched)', firstPlay(log, 'B') - lastDone(log, 'A') < 80, `${firstPlay(log, 'B') - lastDone(log, 'A')} ms gap`);
    check('queue: pending back to 0', Speech.pending === 0, Speech.pending);
  }
  { // Odd byte splits across network chunks decode correctly.
    const { Speech, log } = makeEnv({ firstMs: () => 20, durMs: () => 300, chunks: 5, oddSplit: true });
    Speech.unlock(); Speech.say('Q'); await sleep(700);
    check('odd byte split: samples decode to the right value', plays(log).every((c) => c === 'Q') && plays(log).length >= 1, plays(log).join(''));
  }
  { // Interrupt: new alert cuts the current one; a queued older one never plays.
    const { Speech, log } = makeEnv({ firstMs: () => 40, durMs: () => 600 });
    Speech.unlock(); Speech.interrupt = true;
    Speech.say('A'); await sleep(200); Speech.say('B'); await sleep(10); Speech.say('C'); await sleep(1200);
    const p = plays(log);
    check('interrupt: A cut, B dropped, C plays fully', log.includes('stop') && !p.includes('B') && p.includes('C') && !log.some((l) => l.startsWith('done A') && Number(l.split('@')[1]) > 450), log.join(' '));
  }
  { // Retry before any audio; order kept.
    const { Speech, log, attempts } = makeEnv({ firstMs: () => 30, durMs: () => 100, failFirst: new Set(['A']) });
    Speech.unlock(); Speech.say('A'); Speech.say('B'); await sleep(800);
    check('retry: A retried once and played before B', attempts.A === 2 && [...new Set(plays(log))].join('') === 'AB', `${attempts.A} ${plays(log).join('')}`);
  }
  { // Cancel (Stop): stops audio, nothing afterwards.
    const { Speech, log } = makeEnv({ firstMs: () => 30, durMs: () => 500 });
    Speech.unlock(); Speech.say('A'); Speech.say('B'); await sleep(150); Speech.cancel(); const n = log.length; await sleep(1000);
    check('cancel: no further audio after Stop', !log.slice(n).some((l) => l.startsWith('play')) && Speech.pending === 0, log.slice(n).join(' '));
  }
  { const { Speech, log } = makeEnv({ firstMs: () => 10, durMs: () => 100 });
    Speech.unlock(); Speech.enabled = false; Speech.say('A'); await sleep(200);
    check('voice off: nothing played', log.length === 0, log.join(' ')); }
  console.log(`${pass}/${total}`);
})();
