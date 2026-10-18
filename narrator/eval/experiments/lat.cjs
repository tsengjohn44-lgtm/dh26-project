const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const img = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[4]).toString('base64');
async function run(body, label) {
  const t0 = performance.now();
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...buildPayload(body, 'perceptron-mk1.5'), stream: false }) });
  const j = await r.json();
  console.log(label.padEnd(8), Math.round(performance.now() - t0) + 'ms', 'prompt_tokens', j.usage?.prompt_tokens, JSON.stringify(j.choices?.[0]?.message?.content));
}
(async () => { for (let i = 0; i < 3; i++) { await run({ image: img }, 'single'); await run({ image: img, prevImage: img, prevDtMs: 1000 }, 'frames'); } })();
