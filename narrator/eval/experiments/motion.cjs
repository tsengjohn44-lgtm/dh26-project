const fs = require('fs');
const { buildPayload, finalizeReply } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const u = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
const far = u('eval768/cyclist.jpg'), close = u('cyclist_close.jpg');
const cases = { 'clip far→close': { image: close, prevImage: far, prevDtMs: 1000 }, 'single close  ': { image: close }, 'clip close→close': { image: close, prevImage: close, prevDtMs: 1000 } };
(async () => { for (const [k, body] of Object.entries(cases)) for (let i = 0; i < 3; i++) {
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(body, 'perceptron-mk1.5')) });
  console.log(k.padEnd(17), finalizeReply((await r.json()).choices[0].message.content, []));
} })();
