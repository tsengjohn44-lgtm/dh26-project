const fs = require('fs');
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const TEXTS = ['Stairs going down ahead, at least 7 steps.', 'Door ahead, sign reads "Lobby".', 'Crosswalk ahead. Bikes crossing from left.'];
function wav(pcm, rate) { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
async function tts(model, text, speed) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_24000', { method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: model, language_code: 'en', ...(speed && { voice_settings: { speed } }) }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function heard(pcm) { const fd = new FormData(); fd.append('model_id', 'scribe_v2'); fd.append('file', new Blob([wav(pcm, 24000)], { type: 'audio/wav' }), 'a.wav');
  return (await (await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': KEY }, body: fd })).json()).text; }
(async () => {
  const variants = [
    ['v4 Turbo, no tag', 'eleven_v4_turbo', '', null],
    ['v4 Turbo, [speaking quickly] (current)', 'eleven_v4_turbo', '[speaking quickly] ', null],
    ['v4 Turbo, [fast-paced]', 'eleven_v4_turbo', '[fast-paced] ', null],
    ['v4 Turbo, [rapidly]', 'eleven_v4_turbo', '[rapidly] ', null],
    ['v4 Turbo, [speaking very quickly]', 'eleven_v4_turbo', '[speaking very quickly] ', null],
    ['Flash v2.5, speed 1.0', 'eleven_flash_v2_5', '', 1.0],
    ['Flash v2.5, speed 1.2', 'eleven_flash_v2_5', '', 1.2],
    ['Flash v2.5, speed 1.3 (range check)', 'eleven_flash_v2_5', '', 1.3],
  ];
  for (const [label, model, tag, speed] of variants) {
    try {
      let total = 0, spoken = [];
      for (const t of TEXTS) { const pcm = await tts(model, tag + t, speed); total += pcm.length / 48000; if (tag) spoken.push(await heard(pcm)); }
      const leak = tag && spoken.some((h) => /quick|fast|rapid|pace/i.test(h)) ? '  ⚠ TAG SPOKEN: ' + spoken.join(' / ') : '';
      console.log(`${label.padEnd(40)} ${total.toFixed(2)} s for 3 alerts${leak}`);
    } catch (e) { console.log(`${label.padEnd(40)} ERROR ${e.message}`); }
  }
})();
