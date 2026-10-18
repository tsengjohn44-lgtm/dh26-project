const fs = require('fs'); const W = process.argv[2]; const B = 'http://localhost:18080';
const img = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(`${W}/${f}`).toString('base64');
const cases = [
  ['door_hospital.jpg', 0.9, 'door ahead, sensor close'], ['door_glass.jpg', 1.0, 'glass door, sensor close'],
  ['corridor.jpg', 3.5, 'far wall'], ['open_plaza.jpg', 0.7, 'CONFLICT: open space, sensor says close'],
  ['stairs_up.jpg', 2.5, 'stairs (below beam)'], ['curb.jpg', 4.0, 'curb (below beam)'],
  ['room_sign.jpg', 1.2, 'sign close'], ['cyclist.jpg', 1.4, 'cyclist close'],
];
const num = /\b\d+(\.\d+)?\s*(m\b|met|cm|centi|feet|foot|ft)|\b0\.\d/i;
(async () => {
  const rows = []; const lat = { off: [], on: [] };
  for (const [f, d, note] of cases) for (let run = 0; run < 2; run++) for (const mode of ['off', 'on']) {
    const body = { image: img(f), said: [], reasoning: 'none', style: 'safety', ...(mode === 'on' && { sensor: { distanceM: d, heightM: 1 } }) };
    const t0 = Date.now(); const r = await fetch(B + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(); lat[mode].push(Date.now() - t0);
    rows.push({ f, d, note, mode, run, text, numberSaid: num.test(text) });
  }
  for (const r of rows) console.log(`${r.mode.padEnd(3)} ${r.f.padEnd(18)} ${String(r.d).padEnd(4)} ${r.numberSaid ? 'NUMBER! ' : ''}${r.text}`);
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  console.log(`median latency off ${med(lat.off)} ms, on ${med(lat.on)} ms; numbers said with sensor: ${rows.filter((r) => r.mode === 'on' && r.numberSaid).length}/${rows.filter((r) => r.mode === 'on').length}`);
})();
