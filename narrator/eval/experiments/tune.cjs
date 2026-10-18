const fs = require('fs');
function gray(file) { // parse 24/32-bit BMP into grayscale array
  const b = fs.readFileSync(file), off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22)), bpp = b.readUInt16LE(28) / 8;
  const row = Math.ceil((w * bpp) / 4) * 4, out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = off + y * row + x * bpp; out.push(0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2]); }
  return out;
}
// 1 - correlation of the two thumbnails: 0 same view, ~1 unrelated. Ignores exposure changes.
function viewChange(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return 1 - ab / Math.sqrt(aa * bb + 1e-9);
}
const dir = process.argv[2], names = fs.readdirSync(dir).filter((f) => !f.includes('__') && fs.existsSync(dir + '/' + f.slice(0, -4) + '__shake.bmp')).map((f) => f.slice(0, -4));
const T = Object.fromEntries(fs.readdirSync(dir).map((f) => [f.slice(0, -4), gray(`${dir}/${f}`)]));
const exposure = (a) => a.map((v) => Math.min(255, v * 1.35 + 10));
const same = [], step = [], diff = [];
for (const n of names) { same.push(['shake ' + n, viewChange(T[n], T[n + '__shake'])], ['exposure ' + n, viewChange(T[n], exposure(T[n]))]); step.push(['step ' + n, viewChange(T[n], T[n + '__step'])]);
  for (const m of names) if (m > n) diff.push([`${n} vs ${m}`, viewChange(T[n], T[m])]); }
const stats = (arr) => { const v = arr.map((x) => x[1]).sort((a, b) => a - b); return `min ${v[0].toFixed(2)}  median ${v[v.length >> 1].toFixed(2)}  max ${v[v.length - 1].toFixed(2)}`; };
console.log('same view (shake / exposure):', stats(same));
console.log('walked forward (20% zoom):   ', stats(step));
console.log('different views:             ', stats(diff));
console.log('closest different views:', diff.sort((a, b) => a[1] - b[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
console.log('largest same-view changes:', same.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
for (const t of [0.3, 0.4, 0.5, 0.6]) console.log(`threshold ${t}: same-view false resets ${same.filter((x) => x[1] > t).length}/${same.length}, walked-forward resets ${step.filter((x) => x[1] > t).length}/${step.length}, different views missed ${diff.filter((x) => x[1] <= t).length}/${diff.length}`);
