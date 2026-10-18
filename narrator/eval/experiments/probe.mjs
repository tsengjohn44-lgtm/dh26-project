import fs from 'fs';
const env = fs.readFileSync(process.argv[2], 'utf8');
const KEY = env.match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const img = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[3]).toString('base64');
const extra = JSON.parse(process.argv[4] || '{}');
const t0 = performance.now();
const r = await fetch('https://api.perceptron.inc/v1/chat/completions', {
  method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'perceptron-mk1.5', stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: img } }, { type: 'text', text: 'Describe the surroundings in 1-2 short sentences.' }] }], ...extra }),
});
console.log('status', r.status, r.headers.get('content-type'));
if (!r.ok) { console.log(await r.text()); process.exit(); }
let buf = '', content = '', reasoning = '', tR = null, tC = null, finish = null, usage = null;
const dec = new TextDecoder();
for await (const ch of r.body) {
  buf += dec.decode(ch, { stream: true });
  let i; while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('data:')) { if (line) console.log('OTHER LINE:', line.slice(0, 200)); continue; }
    const d = line.slice(5).trim(); if (d === '[DONE]') continue;
    const j = JSON.parse(d);
    if (j.usage) usage = j.usage;
    if (j.error) console.log('STREAM ERROR', JSON.stringify(j.error));
    for (const c of j.choices || []) {
      if (c.delta?.reasoning_content) { reasoning += c.delta.reasoning_content; tR ??= performance.now() - t0; }
      if (c.delta?.content) { content += c.delta.content; tC ??= performance.now() - t0; }
      if (c.finish_reason) finish = c.finish_reason;
    }
  }
}
console.log({ firstReasoningMs: tR && Math.round(tR), firstContentMs: tC && Math.round(tC), totalMs: Math.round(performance.now() - t0), finish, usage, reasoningChars: reasoning.length });
console.log('REASONING:', reasoning.slice(0, 300));
console.log('CONTENT:', content);
