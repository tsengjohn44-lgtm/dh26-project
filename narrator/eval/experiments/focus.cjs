// Side-by-side replies (production temperature) for two prompt versions on the same images.
const fs = require('fs'), path = require('path');
const A = require(process.argv[2]), B = require(process.argv[3]);
const KEY = fs.readFileSync(process.argv[4], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const imgs = process.argv.slice(5);
async function ask(mod, img) { for (let a = 0; a < 3; a++) { const t = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(mod.buildPayload({ image: img }, 'perceptron-mk1.5')) })).text(); try { return JSON.parse(t).choices[0].message.content.trim().replace(/\s+/g, ' '); } catch { await new Promise((r) => setTimeout(r, 1500)); } } return 'ERROR'; }
(async () => {
  const queue = [...imgs];
  const out = {};
  await Promise.all([1, 2, 3].map(async () => { for (let f; (f = queue.shift());) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
    const a = [await ask(A, img), await ask(A, img)], b = [await ask(B, img), await ask(B, img)];
    out[path.basename(f, '.jpg')] = `  old: ${[...new Set(a)].join('  ||  ')}\n  new: ${[...new Set(b)].join('  ||  ')}`;
  } }));
  for (const k of Object.keys(out).sort()) console.log(`## ${k}\n${out[k]}`);
})();
