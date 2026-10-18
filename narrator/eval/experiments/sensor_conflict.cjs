const fs = require('fs'); const W = process.argv[2]; const B = 'http://localhost:18080';
const img = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(`${W}/${f}`).toString('base64');
(async () => {
  for (const f of ['corridor.jpg', 'open_parking.jpg', 'open_concourse.jpg', 'open_atrium.jpg']) for (const sensor of [undefined, { distanceM: 0.6, heightM: 1 }]) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(B + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img(f), said: [], reasoning: 'none', style: 'safety', sensor }) });
      out.push(await r.text());
    }
    console.log(`${sensor ? 'on  0.6 m' : 'off      '} ${f.padEnd(20)} ${out.join(' | ')}`);
  }
})();
