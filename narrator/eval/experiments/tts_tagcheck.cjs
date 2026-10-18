const fs = require('fs');
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const H = { 'xi-api-key': KEY };
function wav(pcm, rate) { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
async function tts(text) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_24000', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: 'eleven_v4_turbo', language_code: 'en' }) });
  if (!r.ok) throw new Error(await r.text()); return Buffer.from(await r.arrayBuffer());
}
async function stt(pcm) {
  const fd = new FormData(); fd.append('model_id', 'scribe_v2'); fd.append('file', new Blob([wav(pcm, 24000)], { type: 'audio/wav' }), 'a.wav');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: H, body: fd });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200)); return j.text;
}
(async () => {
  for (const text of ['[speaking quickly] Stairs going down ahead, at least 6 steps. Door on right.', '[speaking quickly] Door ahead, sign reads "Class Room 71A".', '[speaking quickly] Curb close ahead.']) {
    for (let i = 0; i < 2; i++) { const pcm = await tts(text); console.log(`${(pcm.length / 48000).toFixed(2)} s | heard: ${await stt(pcm)}`); }
  }
  const plain = await tts('Door ahead, sign reads "Class Room 71A".'); console.log(`(no tag) ${(plain.length / 48000).toFixed(2)} s | heard: ${await stt(plain)}`);
})().catch((e) => console.log('ERROR', e.message));
