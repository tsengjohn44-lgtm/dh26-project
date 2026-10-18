// usage: node stairtest.cjs <prompt.js> <.env> <dir> [runs]  -> direction + count accuracy per image
const fs = require('fs'), path = require('path');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4], runs = Number(process.argv[5] || 4);
const truth = { up1: ['up', 25], up2: ['up', 12], up3: ['up', 2], down0: ['down', 8], down1: ['down', 12], down2: ['down', 10] };
async function ask(img) { for (let a = 0; a < 3; a++) { const t = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...buildPayload({ image: img }, 'perceptron-mk1.5'), temperature: 0.7 }) })).text(); try { return JSON.parse(t).choices[0].message.content.trim(); } catch { await new Promise((r) => setTimeout(r, 1500)); } } return 'ERROR'; }
(async () => {
  let dirOk = 0, dirStated = 0, over = 0, counted = 0, total = 0;
  const queue = Object.keys(truth);
  await Promise.all([1, 2, 3].map(async () => { for (let n; (n = queue.shift());) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, n + '.jpg')).toString('base64');
    const outs = []; for (let i = 0; i < runs; i++) outs.push(await ask(img));
    for (const o of outs) {
      total++;
      const d = /\bup(ward|wards)?\b|ascend/i.test(o) ? 'up' : /\bdown(ward|wards)?\b|descend/i.test(o) ? 'down' : null;
      if (d) { dirStated++; dirOk += d === truth[n][0]; }
      const m = o.match(/(\d+)\s*(steps?|stairs?)/i); if (m) { counted++; over += Number(m[1]) > truth[n][1]; }
    }
    console.log(`${n.padEnd(6)} truth ${truth[n][0]} ~${truth[n][1]} | ${[...new Set(outs)].join('  ||  ')}`);
  } }));
  console.log(`\ndirection stated ${dirStated}/${total}, correct ${dirOk}/${dirStated}; count given ${counted}/${total}, overestimates ${over}/${counted}`);
})();
