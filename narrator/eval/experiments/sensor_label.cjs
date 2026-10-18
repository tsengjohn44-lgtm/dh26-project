const fs = require('fs'); const B = 'http://localhost:18080';
const image = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[2]).toString('base64');
(async () => {
  for (const sensor of [undefined, { distanceM: 0.6, heightM: 1 }, { distanceM: 3, heightM: 1 }]) {
    const out = [];
    for (let i = 0; i < 8; i++) { const r = await fetch(B + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, said: [], reasoning: 'none', style: 'safety', sensor }) }); out.push((await r.text()).split(':')[0]); }
    console.log(`${sensor ? sensor.distanceM + ' m' : 'off  '}: Drop-off ${out.filter((x) => x === 'Drop-off').length}/8, Trip hazard ${out.filter((x) => x === 'Trip hazard').length}/8, other: ${out.filter((x) => !['Drop-off', 'Trip hazard'].includes(x)).join(', ')}`);
  }
})();
