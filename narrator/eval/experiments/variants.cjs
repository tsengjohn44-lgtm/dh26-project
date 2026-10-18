const fs = require('fs'), path = require('path');
const { buildPayload, SYSTEM_PROMPT } = require(process.argv[2]);
const Filter = require(process.argv[3]);
const KEY = fs.readFileSync(process.argv[4], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[5];
const OLD_REPEAT = /"Already said" is what the person already knows\.[^\n]*/;
const NEW_REPEAT = `"Already said" lists what you told the person recently. Report what in this frame is important and not already covered there. A different place with its own hazards, cues or text is new and must be reported. The same thing again, in other words or with a different step count, is not new; except a hazard now within 2 steps that was farther before.`;
const LIST_RULE = `\n- If a sign lists several rooms or names, give them in one alert, e.g. Sign: rooms 71A, 71B, 71F, arrow right.`;
const V2 = SYSTEM_PROMPT.replace(OLD_REPEAT, NEW_REPEAT).replace('- Ignore colors', LIST_RULE.trim() + '\n- Ignore colors');
if (V2 === SYSTEM_PROMPT || !V2.includes('Sign: rooms')) throw new Error('prompt patch failed');
const variants = { V1: { sys: SYSTEM_PROMPT, sendSaid: true }, V2: { sys: V2, sendSaid: true }, V3: { sys: V2, sendSaid: false } };
const img = (n) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, n + '.jpg')).toString('base64');
async function ask(v, image, said) {
  const p = buildPayload({ image, said: v.sendSaid ? said : [] }, 'perceptron-mk1.5');
  p.messages[0].content = v.sys;
  for (let a = 0; a < 3; a++) { const t = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).text();
    try { return Filter.finalizeReply(JSON.parse(t).choices[0].message.content, said) || 'n/a'; } catch { await new Promise((r) => setTimeout(r, 1500)); } }
  return 'ERROR';
}
const names = ['building_sign', 'crosswalk', 'curb', 'pothole', 'room_sign', 'stairs'];
(async () => {
  if (process.argv[6] === 'show') { console.log(V2); return; }
  for (const [vn, v] of Object.entries(variants)) {
    let fresh = 0, after = 0, quiet = 0; const notes = [];
    const queue = [...names];
    await Promise.all([1, 2, 3].map(async () => { for (let n; (n = queue.shift());) {
      const other = names[(names.indexOf(n) + 1) % names.length];
      const otherAlert = await ask(v, img(other), []);
      const f = await ask(v, img(n), []);
      const a = await ask(v, img(n), otherAlert === 'n/a' ? [] : [otherAlert]);
      const own = a !== 'n/a' ? a : f;
      const q = await ask(v, img(n), own === 'n/a' ? [] : [own]);
      fresh += f !== 'n/a'; after += a !== 'n/a'; quiet += q === 'n/a';
      notes.push(`  ${n.padEnd(14)} fresh: ${f} | after other: ${a} | repeat: ${q}`);
    } }));
    console.log(`=== ${vn}: alerts fresh ${fresh}/${names.length}, alerts after unrelated alert ${after}/${names.length}, quiet on repeat ${quiet}/${names.length}`);
    notes.sort().forEach((l) => console.log(l));
  }
})();
