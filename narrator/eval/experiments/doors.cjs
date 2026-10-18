// usage: node doors.cjs <prompt.js> <.env> <dir> [runs]
const fs = require('fs'), path = require('path');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4], runs = Number(process.argv[5] || 4);
const DOOR = /\b(door|doors|doorway|doorways|entrance|entry|exit)\b/i;
async function ask(img) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...buildPayload({ image: img }, 'perceptron-mk1.5'), temperature: 0.7 }) });
    const t = await r.text();
    try { return (JSON.parse(t).choices?.[0]?.message?.content || '').trim(); } catch { await new Promise((s) => setTimeout(s, 2000)); }
  }
  return 'ERROR';
}
(async () => {
  let fp = 0, fpTot = 0, tp = 0, tpTot = 0;
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  const queue = [...names];
  await Promise.all([1, 2, 3].map(async () => { for (let f; (f = queue.shift());) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
    const outs = []; for (let i = 0; i < runs; i++) outs.push(await ask(img));
    const hits = outs.filter((o) => DOOR.test(o)).length;
    if (f.startsWith('open')) { fp += hits; fpTot += runs; } else { tp += hits; tpTot += runs; }
    console.log(`${f.padEnd(24)} door ${hits}/${runs} | ${[...new Set(outs)].join('  ||  ')}`);
  } }));
  console.log(`\nopen spaces called door/entrance: ${fp}/${fpTot}    door images mentioning a door/entrance: ${tp}/${tpTot}`);
})();
