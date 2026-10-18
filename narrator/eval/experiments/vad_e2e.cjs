const R = require(require('path').join(__dirname, '..', '..', 'public', 'recorder.js'));
const fs = require('fs'); const B = 'http://localhost:18080';
const image = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[2]).toString('base64');
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
(async () => {
  for (const q of ['What does the sign say?', 'Is it safe to keep walking forward?', 'Hmm, what is, uh... what is in front of me?']) {
    const r = await fetch(B + '/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q }) });
    const rate = Number(r.headers.get('x-sample-rate')); const pcm = new Int16Array((await r.arrayBuffer()).slice(0));
    // 48 kHz mic: 0.6 s room noise, the question, then 3 s of room noise
    const up = 48000 / rate, speech = Float32Array.from({ length: pcm.length * up }, (_, i) => pcm[Math.floor(i / up)] / 32768);
    const pad = (s) => Float32Array.from({ length: s * 48000 }, () => 0.004 * rnd());
    const all = new Float32Array([...pad(0.6), ...Array.from(speech, (v) => v + 0.004 * rnd()), ...pad(3)]);
    const d = R.createSpeechDetector(48000); let t = 0, ev = [];
    for (let i = 0; i < all.length; i += 128) { const c = all.subarray(i, i + 128); t += c.length / 48; const e = d.push(c); if (e) ev.push(`${e}@${Math.round(t)}ms`); if (e === 'silence') break; }
    const keep = Math.ceil((d.lastSpeechMs + R.TRAIL_MS) / 1000 * 48000);
    const audio = R.toBase64(R.encodeWav(R.downsample(all.subarray(0, keep), 48000)));
    const t0 = Date.now();
    const a = await fetch(B + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, audio, reasoning: 'none' }) });
    console.log(`"${q}" speech ends ${Math.round(0.6 * 1000 + speech.length / 48)}ms | ${ev.join(' ')} | sent ${(keep / 48000).toFixed(2)}s | ${a.status} ${Date.now() - t0}ms: ${await a.text()}`);
  }
})();
