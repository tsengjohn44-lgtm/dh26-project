import fs from 'fs';
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const d = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
const mode = process.argv[3];
const media = mode.includes('frames')
  ? { type: 'video_frames', video_frames: { frames: [{ image_url: { url: d('street.jpg') }, timestamp_ms: 0 }, { image_url: { url: d('street.jpg') }, timestamp_ms: 1000 }] } }
  : { type: 'image_url', image_url: { url: d('street.jpg') } };
const body = { model: 'perceptron-mk1.5', stream: true, reasoning_effort: 'none', max_completion_tokens: 40, temperature: 0.2,
  messages: [{ role: 'user', content: [media, { type: 'text', text: 'In at most 12 words, name any hazard for a pedestrian. If none, reply n/a' }] }] };
if (mode.includes('regex')) body.regex = 'n/a|[A-Z][^\\n]{2,89}';
const t0 = performance.now();
const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!r.ok) { console.log(mode, r.status, await r.text()); process.exit(); }
let buf = '', out = '', tC = null, usage = null, fin = null; const dec = new TextDecoder();
for await (const ch of r.body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l.startsWith('data:') || l.includes('[DONE]')) continue; const j = JSON.parse(l.slice(5)); if (j.usage) usage = j.usage; for (const c of j.choices || []) { if (c.delta?.content) { out += c.delta.content; tC ??= performance.now() - t0; } if (c.finish_reason) fin = c.finish_reason; } } }
console.log(mode.padEnd(14), `first ${Math.round(tC)}ms total ${Math.round(performance.now() - t0)}ms prompt_tokens ${usage?.prompt_tokens} fin ${fin} ->`, JSON.stringify(out));
