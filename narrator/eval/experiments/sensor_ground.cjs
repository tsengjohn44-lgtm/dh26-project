const fs = require('fs'); const W = process.argv[2]; const B = 'http://localhost:18080';
const img = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(`${W}/${f}`).toString('base64');
(async () => {
  for (const [f, d] of [['curb.jpg', 4], ['pothole.jpg', 4], ['stairs.jpg', 3.5]]) for (const sensor of [undefined, { distanceM: d, heightM: 1 }]) {
    const out = [];
    for (let i = 0; i < 4; i++) { const r = await fetch(B + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img(f), said: [], reasoning: 'none', style: 'safety', sensor }) }); out.push(await r.text()); }
    console.log(`${sensor ? 'on ' : 'off'} ${f.padEnd(12)} ${out.join(' | ')}`);
  }
})();
