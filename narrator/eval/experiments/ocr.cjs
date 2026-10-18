const fs = require('fs');
const { buildPayload, finalizeReply, isRepeat } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
console.log('room 214 vs 215 repeat?', isRepeat('Door on right, sign reads "Room 215".', ['Door on right, sign reads "Room 214".']), '| stairs 4 vs 5 repeat?', isRepeat('Stairs down, 4 steps ahead.', ['Stairs down, 5 steps ahead.']));
(async () => { for (const s of [512, 768]) for (let i = 0; i < 4; i++) {
  const img = 'data:image/jpeg;base64,' + fs.readFileSync(`room_${s}.jpg`).toString('base64');
  const t0 = performance.now();
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...buildPayload({ image: img }, 'perceptron-mk1.5'), temperature: 0.7 }) });
  const j = await r.json();
  console.log(s, Math.round(performance.now() - t0) + 'ms', 'tokens', j.usage?.prompt_tokens, finalizeReply(j.choices[0].message.content, []));
} })();
