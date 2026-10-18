const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const img = 'data:image/jpeg;base64,' + fs.readFileSync(process.argv[4]).toString('base64');
const said = JSON.parse(process.argv[5]);
(async () => { for (let i = 0; i < Number(process.argv[6] || 4); i++) {
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload({ image: img, said }, 'perceptron-mk1.5')) });
  console.log('  ', JSON.stringify((await r.json()).choices?.[0]?.message?.content));
} })();
