import fs from 'fs';
const KEY = fs.readFileSync(process.argv[2], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const img = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[3]).toString('base64');
const previous = process.argv[4] || '';
const SYSTEM = process.argv[5];
const userText = previous ? `Previous description: "${previous}"\nDescribe the current frame.` : 'Describe the current frame.';
const t0 = performance.now();
const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'perceptron-mk1.5', reasoning_effort: 'none', max_completion_tokens: 80,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: [{ type: 'image_url', image_url: { url: img } }, { type: 'text', text: userText }] }] }) });
const j = await r.json();
console.log(Math.round(performance.now() - t0) + 'ms', JSON.stringify(j.choices?.[0]?.message?.content ?? j));
