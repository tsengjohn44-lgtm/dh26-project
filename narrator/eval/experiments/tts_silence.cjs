const fs = require('fs');
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const TEXT = 'Stairs going down ahead, at least 6 steps. Door on right.';
async function run(label, model, text, settings) {
  const t0 = performance.now();
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_24000`, { method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: model, language_code: 'en', ...(settings && { voice_settings: settings }) }) });
  if (!r.ok) return console.log(label, r.status, (await r.text()).slice(0, 150));
  const chunks = []; let first; for await (const c of r.body) { first ??= performance.now() - t0; chunks.push(c); }
  const total = performance.now() - t0;
  const buf = Buffer.concat(chunks), n = buf.length >> 1, s = new Int16Array(buf.buffer, buf.byteOffset, n);
  const win = 240, loud = []; for (let i = 0; i + win <= n; i += win) { let m = 0; for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(s[j])); loud.push(m > 600); }
  const lead = loud.indexOf(true) * win / 24000, trail = (loud.length - 1 - loud.lastIndexOf(true)) * win / 24000;
  console.log(label.padEnd(36), `audio ${(n / 24000).toFixed(2)} s (silence: start ${lead.toFixed(2)} s, end ${trail.toFixed(2)} s) | first byte ${Math.round(first)} ms, all ${Math.round(total)} ms`);
}
(async () => {
  await run('v4_turbo speed 1.0', 'eleven_v4_turbo', TEXT);
  await run('v4_turbo "[quickly]" tag', 'eleven_v4_turbo', '[speaking quickly] ' + TEXT);
  await run('flash_v2_5 speed 1.0', 'eleven_flash_v2_5', TEXT);
  await run('flash_v2_5 speed 1.2', 'eleven_flash_v2_5', TEXT, { speed: 1.2 });
  await run('multilingual_v2 speed 1.2', 'eleven_multilingual_v2', TEXT, { speed: 1.2 });
})();
