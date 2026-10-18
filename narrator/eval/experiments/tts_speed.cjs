const fs = require('fs');
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const TEXT = 'Stairs going down ahead, at least 6 steps. Door on right.';
async function run(label, { model = 'eleven_v4_turbo', format = 'mp3_44100_128', settings } = {}) {
  const t0 = performance.now();
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=${format}`, { method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: TEXT, model_id: model, language_code: 'en', ...(settings && { voice_settings: settings }) }) });
  if (!r.ok) return console.log(label.padEnd(34), 'HTTP', r.status, (await r.text()).slice(0, 200));
  let first = null, bytes = 0;
  for await (const c of r.body) { first ??= performance.now() - t0; bytes += c.length; }
  const total = performance.now() - t0;
  const sec = format.startsWith('pcm') ? bytes / 2 / Number(format.split('_')[1]) : bytes * 8 / (Number(format.split('_')[2]) * 1000);
  console.log(label.padEnd(34), `first byte ${Math.round(first)} ms, all ${Math.round(total)} ms, audio ${sec.toFixed(2)} s, region ${r.headers.get('x-region') || '?'}`);
}
(async () => {
  await run('warm-up', { format: 'pcm_24000' });
  for (const sp of [1.0, 1.1, 1.2]) await run('v4_turbo pcm_24000 speed '+sp, { format: 'pcm_24000', settings: { speed: sp } });
  await run('flash_v2_5 pcm_24000 speed 1.2', { model: 'eleven_flash_v2_5', format: 'pcm_24000', settings: { speed: 1.2 } });
  await run('v4_turbo speed 1.25 (range check)', { format: 'pcm_24000', settings: { speed: 1.25 } });
  await run('v4_turbo speed 1.5 (range check)', { format: 'pcm_24000', settings: { speed: 1.5 } });
})();