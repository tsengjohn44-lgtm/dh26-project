const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const img = (s) => 'data:image/jpeg;base64,' + fs.readFileSync(`cw_${s}.jpg`).toString('base64');
async function one(payload) {
  const t0 = performance.now();
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j));
  return { ms: performance.now() - t0, pt: j.usage?.prompt_tokens };
}
const med = (a) => { a = [...a].sort((x, y) => x - y); return Math.round(a[a.length >> 1]); };
(async () => {
  await one(buildPayload({ image: img(512) }, 'perceptron-mk1.5')); // warm connection
  for (const s of [384, 512, 768]) {
    const ms = []; let pt;
    for (let i = 0; i < 6; i++) { const r = await one(buildPayload({ image: img(s) }, 'perceptron-mk1.5')); ms.push(r.ms); pt = r.pt; }
    console.log(`full prompt  ${s}px  tokens ${pt}  median ${med(ms)}ms  min ${Math.round(Math.min(...ms))}  max ${Math.round(Math.max(...ms))}`);
  }
  const ms = [];
  for (let i = 0; i < 6; i++) { const p = buildPayload({ image: img(768) }, 'perceptron-mk1.5'); p.messages[0].content = 'Name hazards for a blind walker in under 12 words, or n/a.'; ms.push((await one(p)).ms); }
  console.log(`tiny prompt  768px  median ${med(ms)}ms`);
  for (const k of [2, 3]) {
    const all = [];
    for (let round = 0; round < 3; round++) all.push(...(await Promise.all(Array.from({ length: k }, () => one(buildPayload({ image: img(768) }, 'perceptron-mk1.5'))))).map((r) => r.ms));
    console.log(`${k} in flight  768px  median ${med(all)}ms  max ${Math.round(Math.max(...all))}`);
  }
})();
