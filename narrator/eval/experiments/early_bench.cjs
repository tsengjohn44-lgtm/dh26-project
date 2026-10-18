// Time from "phone receives the describe reply" to "first audio byte from /api/speak".
// netMs simulates the phone<->laptop hop each way (applied to the speak request's travel).
const fs = require('fs');
const Filter = require(process.argv[2]);
const [base, dir, netMs] = [process.argv[3], process.argv[4], Number(process.argv[5] || 0)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imgs = ['stairs', 'room_sign', 'building_sign', 'curb', 'crosswalk', 'pothole', 'corridor'];
(async () => {
  const out = [];
  for (const n of imgs) {
    const image = 'data:image/jpeg;base64,' + fs.readFileSync(`${dir}/${n}.jpg`).toString('base64');
    const r = await fetch(base + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, said: [] }) });
    const reply = await r.text();
    const tReply = performance.now();          // reply has reached the laptop side of the hop
    await sleep(netMs);                        // ...travels to the phone
    const text = Filter.classifyReply(reply, []).text;
    if (!text) { console.log(`  ${n}: n/a, skipped`); continue; }
    await sleep(netMs);                        // speak request travels back to the laptop
    const s = await fetch(base + '/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    let first; for await (const c of s.body) { first ??= performance.now(); }
    const ms = Math.round(first - tReply + netMs); // + final hop of audio back to the phone
    out.push(ms);
    console.log(`  ${n.padEnd(14)} ${String(ms).padStart(4)} ms  early=${s.headers.get('x-speech-early')}  "${text}"`);
    await sleep(300);
  }
  out.sort((a, b) => a - b);
  console.log(`  median ${out[out.length >> 1]} ms over ${out.length} alerts`);
})();
