const fs = require('fs'), path = require('path');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4];
(async () => {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  let bad = 0, stairsOk = 0, stairsTot = 0, n = 0;
  const queue = [...names];
  await Promise.all([1, 2, 3].map(async () => { for (let f; (f = queue.shift());) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
    const outs = [];
    for (let i = 0; i < 3; i++) { const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...buildPayload({ image: img }, 'perceptron-mk1.5'), temperature: 0.7 }) });
      outs.push(((await r.json()).choices?.[0]?.message?.content || '').trim()); }
    for (const o of outs) {
      n++;
      const hasCount = /\d+\s*steps?|steps? away/i.test(o), isStairs = /stair/i.test(o);
      if (hasCount && !isStairs) bad++;
      if (isStairs) { stairsTot++; stairsOk += /at least \d+/i.test(o); }
    }
    console.log(f.padEnd(24), [...new Set(outs)].join('  ||  '));
  } }));
  console.log(`\nnon-stair replies with a distance/step count: ${bad}/${n}    stair replies with "at least N": ${stairsOk}/${stairsTot}`);
})();
