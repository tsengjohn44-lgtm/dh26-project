// Simulated walk using app.js's scheduling, now with view-change detection (VIEW_CHANGE reset).
const fs = require('fs');
const Filter = require(process.argv[2]);
const [base, useViews, dir, thumbs] = [process.argv[3], process.argv[4] === 'views', process.argv[5], process.argv[6]];
function gray(file) { const b = fs.readFileSync(file), off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22)), bpp = b.readUInt16LE(28) / 8, row = Math.ceil((w * bpp) / 4) * 4, out = [];
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) { const i = off + y * row + x * bpp; out.push(0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2]); } return out; }
const scenes = [
  ['stairs', /stair/i], ['stairs_up', /stair|step/i], ['door_open_doorway', /door|coroner/i], ['room_sign', /71|room|door/i], ['curb', /curb|ramp/i], ['building_sign', /bella|concert|entrance|door/i],
].map(([n, re]) => ({ n, re, ms: 5000, data: 'data:image/jpeg;base64,' + fs.readFileSync(`${dir}/${n}.jpg`).toString('base64'), thumb: gray(`${thumbs}/${n}.bmp`) }));
const t0 = Date.now(), total = scenes.reduce((a, s) => a + s.ms, 0);
const sceneAt = (t) => { let acc = 0; for (const s of scenes) { acc += s.ms; if (t < acc) return s; } return null; };
const sceneStart = (s) => scenes.slice(0, scenes.indexOf(s)).reduce((a, x) => a + x.ms, 0);
let said = [], inFlight = 0, seq = 0, shownSeq = 0, viewId = 0, viewThumb = null; const detected = new Map(), log = [];
async function send() {
  const s = sceneAt(Date.now() - t0); if (!s) return;
  if (useViews) { if (viewThumb && Filter.viewChange(viewThumb, s.thumb) > 0.5) { viewId++; said = []; } if (!viewThumb || said.length === 0) viewThumb = viewThumb && Filter.viewChange(viewThumb, s.thumb) <= 0.5 ? viewThumb : s.thumb; }
  const my = ++seq, view = viewId; inFlight++;
  try {
    const r = await fetch(base + '/api/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: s.data, said }) });
    const reply = await r.text(), t = Date.now() - t0;
    if (!r.ok) { log.push(`${t}ms ERROR`); return; }
    if (my < shownSeq || view !== viewId) return; shownSeq = my;
    const { text, reason } = Filter.classifyReply(reply, said);
    if (!text) { if (reason === 'repeat') log.push(`${(t / 1000).toFixed(1)}s  [${s.n}]  (filtered as repeat: ${reply})`); return; }
    said = [...said, text].slice(-5); log.push(`${(t / 1000).toFixed(1)}s  [${s.n}]  ${text}`);
    const cur = sceneAt(t); if (cur && cur.re.test(text) && !detected.has(cur.n)) detected.set(cur.n, t - sceneStart(cur));
  } finally { inFlight--; }
}
(async () => {
  while (Date.now() - t0 < total) { if (inFlight < 3) send(); await new Promise((r) => setTimeout(r, 400)); }
  while (inFlight) await new Promise((r) => setTimeout(r, 50));
  console.log(`=== view-change detection ${useViews ? 'ON' : 'OFF'}`); log.forEach((l) => console.log('  ' + l));
  console.log('  scene change -> alert:', scenes.slice(1).map((s) => `${s.n} ${detected.has(s.n) ? (detected.get(s.n) / 1000).toFixed(1) + 's' : 'MISSED'}`).join(', '));
})();
