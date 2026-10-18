// Simulated walk against the running server: the "camera" shows one scene, then switches.
// Measures how long after each switch an alert about the new scene is shown, using the same
// scheduling as public/app.js (interval + max in flight + drop stale replies + Filter).
const fs = require('fs');
const Filter = require(process.argv[2]);
const [base, mode] = [process.argv[3], process.argv[4]];
const dir = process.argv[5];
const img = (n) => 'data:image/jpeg;base64,' + fs.readFileSync(`${dir}/${n}.jpg`).toString('base64');
const scenes = [ // [image, ms on screen, regex an alert about it should match]
  ['stairs', 5000, /stair/i], ['room_sign', 5000, /71|room|door/i], ['crosswalk', 5000, /crosswalk|car|intersection/i], ['curb', 5000, /curb|ramp/i], ['building_sign', 5000, /bella|concert|entrance/i],
].map(([n, ms, re]) => ({ n, ms, re, data: img(n) }));
const INTERVAL = mode === 'pipelined' ? 400 : 0, MAX = mode === 'pipelined' ? 3 : 1;
const t0 = Date.now(), total = scenes.reduce((a, s) => a + s.ms, 0);
const sceneAt = (t) => { let acc = 0; for (const s of scenes) { acc += s.ms; if (t < acc) return s; } return null; };
const sceneStart = (s) => scenes.slice(0, scenes.indexOf(s)).reduce((a, x) => a + x.ms, 0);
let said = [], inFlight = 0, seq = 0, shownSeq = 0, requests = 0; const detected = new Map(), shown = [];
async function send() {
  const now = Date.now() - t0, s = sceneAt(now); if (!s) return;
  const my = ++seq; inFlight++; requests++;
  try {
    const r = await fetch(base + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: s.data, said }) });
    const reply = await r.text(); const t = Date.now() - t0;
    if (!r.ok) { shown.push(`${t}ms ERROR ${reply.slice(0, 80)}`); return; }
    if (my < shownSeq) return; shownSeq = my;
    const text = Filter.finalizeReply(reply, said); if (!text) return;
    said = [...said, text].slice(-5); shown.push(`${(t / 1000).toFixed(1)}s  [frame of ${s.n}]  ${text}`);
    const cur = sceneAt(t);
    if (cur && cur.re.test(text) && !detected.has(cur.n)) detected.set(cur.n, t - sceneStart(cur));
  } finally { inFlight--; }
}
(async () => {
  while (Date.now() - t0 < total) {
    if (inFlight < MAX) { const p = send(); if (MAX === 1) await p; }
    await new Promise((r) => setTimeout(r, INTERVAL || 5));
  }
  while (inFlight) await new Promise((r) => setTimeout(r, 50));
  console.log(`=== ${mode}: ${requests} requests in ${total / 1000}s (${Math.round(requests / total * 60000)}/min)`);
  shown.forEach((l) => console.log('  ' + l));
  const lags = scenes.slice(1).map((s) => [s.n, detected.get(s.n)]);
  console.log('  time from scene change to alert:', lags.map(([n, ms]) => `${n} ${ms === undefined ? 'missed' : (ms / 1000).toFixed(1) + 's'}`).join(', '));
})();
