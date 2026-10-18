const fs = require('fs');
const [base, keyFile, label, doStt] = process.argv.slice(2);
const KEY = fs.readFileSync(keyFile, 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
function wav(pcm, rate) { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
(async () => {
  let total = 0;
  for (const text of ['Stairs going down ahead, at least 7 steps.', 'Door ahead. Sign: Class Room 71A, 71B, 71F, 71G, arrow left.', 'Crosswalk ahead. Bikes crossing from left.']) {
    const r = await fetch(base + '/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const pcm = Buffer.from(await r.arrayBuffer()), rate = Number(r.headers.get('x-sample-rate')), sec = pcm.length / 2 / rate; total += sec;
    let heard = '';
    if (doStt === '1') { const fd = new FormData(); fd.append('model_id', 'scribe_v2'); fd.append('file', new Blob([wav(pcm, rate)], { type: 'audio/wav' }), 'a.wav');
      heard = ' | heard: ' + (await (await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': KEY }, body: fd })).json()).text; }
    console.log(`  ${label}: ${sec.toFixed(2)} s${heard}`);
  }
  console.log(`  ${label} total ${total.toFixed(2)} s`);
})();
