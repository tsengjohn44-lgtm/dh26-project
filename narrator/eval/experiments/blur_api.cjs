const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4];
async function ask(f) { const img = 'data:image/jpeg;base64,' + fs.readFileSync(`${dir}/${f}.jpg`).toString('base64');
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload({ image: img }, 'perceptron-mk1.5')) });
  return ((await r.json()).choices?.[0]?.message?.content || '').trim(); }
(async () => { for (const n of ['room_sign', 'building_sign', 'stairs', 'curb', 'crosswalk']) {
  const sharp = [await ask(n), await ask(n)], blur = [await ask(n + '_blur'), await ask(n + '_blur')];
  console.log(`## ${n}\n  sharp:   ${[...new Set(sharp)].join('  ||  ')}\n  blurred: ${[...new Set(blur)].join('  ||  ')}`);
} })();
