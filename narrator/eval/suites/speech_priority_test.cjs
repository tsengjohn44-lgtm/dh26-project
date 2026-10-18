// speech.js hazard priority: urgent (labelled) clips cut non-urgent ones, never other hazards. Fake fetch streams + Web Audio clock.
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
  { // urgent cuts a playing non-urgent clip and drops queued non-urgent ones
    const { Speech, log } = makeEnv({ firstMs: () => 30, durMs: (t) => 600 });
    Speech.unlock(); Speech.say('A'); Speech.say('B'); await sleep(200);   // A playing, B queued
    Speech.say('H', { urgent: true }); await sleep(1200);
    const p = plays(log);
    check('urgent: playing non-urgent clip A is cut', log.includes('stop') && !log.some((l) => l.startsWith('done A') && Number(l.split('@')[1]) > 500), log.join(' '));
    check('urgent: queued non-urgent B dropped, never plays', !p.includes('B'), p.join(''));
    check('urgent: H plays fully right after', p.includes('H') && log.some((l) => l.startsWith('done H')) && firstPlay(log, 'H') < 400, log.join(' '));
  }
  { // urgent never cuts urgent: queues after it, order kept
    const { Speech, log } = makeEnv({ firstMs: () => 30, durMs: () => 400 });
    Speech.unlock(); Speech.say('H', { urgent: true }); await sleep(150); Speech.say('J', { urgent: true }); await sleep(1200);
    check('urgent after urgent: no cut, both play in order', !log.includes('stop') && [...new Set(plays(log))].join('') === 'HJ' && firstPlay(log, 'J') >= lastDone(log, 'H') - 5, log.join(' '));
  }
  { // non-urgent after urgent: queued behind it (normal)
    const { Speech, log } = makeEnv({ firstMs: () => 30, durMs: () => 300 });
    Speech.unlock(); Speech.say('H', { urgent: true }); await sleep(100); Speech.say('A'); await sleep(1000);
    check('non-urgent after urgent waits its turn', !log.includes('stop') && [...new Set(plays(log))].join('') === 'HA', log.join(' '));
  }
  { // urgent arriving while a non-urgent clip is still downloading (not yet audible)
    const { Speech, log } = makeEnv({ firstMs: (t) => (t === 'A' ? 400 : 30), durMs: () => 300 });
    Speech.unlock(); Speech.say('A'); await sleep(100); Speech.say('H', { urgent: true }); await sleep(1000);
    check('urgent while non-urgent still downloading: A never plays, H does', !plays(log).includes('A') && plays(log).includes('H'), log.join(' '));
  }
  { // Interrupt setting still cuts everything, urgent included
    const { Speech, log } = makeEnv({ firstMs: () => 30, durMs: () => 600 });
    Speech.unlock(); Speech.interrupt = true; Speech.say('H', { urgent: true }); await sleep(200); Speech.say('A'); await sleep(1000);
    check('Interrupt mode: new alert cuts even an urgent clip (unchanged behaviour)', log.includes('stop') && plays(log).includes('A'), log.join(' '));
  }
  { const { Speech } = makeEnv({ firstMs: () => 30, durMs: () => 200 });
    Speech.unlock(); Speech.say('A'); Speech.say('B'); await sleep(50); Speech.say('H', { urgent: true }); await sleep(10);
    check('pending count after an urgent cut = only urgent clips', Speech.pending === 1, String(Speech.pending)); await sleep(600); }
  console.log(`${pass}/${total}`);
})();
