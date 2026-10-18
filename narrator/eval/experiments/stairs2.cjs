// Stair replies at production settings (temperature from buildPayload), N runs each; prints counts.
const fs = require('fs'), path = require('path');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4], runs = Number(process.argv[5] || 6);
const truth = { up1: ['up', 25], up2: ['up', 12], up3: ['up', 2], down0: ['down', 8], down1: ['down', 12], down2: ['down', 10] };
async function ask(img) { for (let a = 0; a < 3; a++) { const t = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload({ image: img }, 'perceptron-mk1.5')) })).text(); try { return JSON.parse(t).choices[0].message.content.trim(); } catch { await new Promise((r) => setTimeout(r, 1500)); } } return 'ERROR'; }
(async () => {
  const rows = [], queue = Object.keys(truth);
  await Promise.all([1, 2, 3].map(async () => { for (let n; (n = queue.shift());) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, n + '.jpg')).toString('base64');
    for (let i = 0; i < runs; i++) { const o = await ask(img); const d = /\bup\b|ascend/i.test(o) ? 'up' : /\bdown\b|descend/i.test(o) ? 'down' : null; const m = o.match(/(\d+)\s*(steps?|stairs?)/i); rows.push({ n, d, c: m ? Number(m[1]) : null }); }
  } }));
  fs.writeFileSync(process.argv[6], JSON.stringify(rows));
  for (const n of Object.keys(truth)) { const r = rows.filter((x) => x.n === n); console.log(`${n.padEnd(6)} truth ${truth[n][0]} ${String(truth[n][1]).padStart(2)} | dirs ${r.map((x) => x.d || '-').join(' ')} | counts ${r.map((x) => x.c ?? '-').join(' ')}`); }
  for (const f of [1, 0.75, 0.6]) {
    const counted = rows.filter((x) => x.c !== null), disc = (c) => Math.max(1, Math.floor(c * f));
    console.log(`discount x${f}: overestimates ${counted.filter((x) => disc(x.c) > truth[x.n][1]).length}/${counted.length}, median ratio to truth ${(() => { const v = counted.map((x) => disc(x.c) / truth[x.n][1]).sort((a, b) => a - b); return v[v.length >> 1].toFixed(2); })()}`);
  }
  const dd = rows.filter((x) => x.d); console.log(`direction stated ${dd.length}/${rows.length}, correct ${dd.filter((x) => x.d === truth[x.n][0]).length}/${dd.length}`);
})();
