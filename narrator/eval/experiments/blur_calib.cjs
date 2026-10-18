const fs = require('fs');
const { sharpness } = require(process.argv[2]);
const dir = process.argv[3];
function gray(file) { const b = fs.readFileSync(file), off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22)), bpp = b.readUInt16LE(28) / 8, row = Math.ceil(w * bpp / 4) * 4, o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = off + (h - 1 - y) * row + x * bpp; o[y * w + x] = 0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2]; } return { g: o, w, h }; }
const W = 160, H = 120;
function hblur(g, k) { const o = new Float32Array(g.length), r = k >> 1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = Math.min(W - 1, Math.max(0, x + d)); s += g[y * W + xx]; n++; } o[y * W + x] = s / n; } return o; }
function vblur(g, k) { const o = new Float32Array(g.length), r = k >> 1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = Math.min(H - 1, Math.max(0, y + d)); s += g[yy * W + x]; n++; } o[y * W + x] = s / n; } return o; }
const box = (g, k) => vblur(hblur(g, k), k);
const bright = (g, f) => g.map((v) => Math.min(255, v * f));
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.bmp') && !f.includes('__')).map((f) => f.slice(0, -4)).sort();
const rows = [];
for (const n of names) {
  const { g } = gray(`${dir}/${n}.bmp`); const s0 = sharpness(g, W, H);
  const shake = sharpness(gray(`${dir}/${n}__shake.bmp`).g, W, H) / s0;
  rows.push({ n, s0, motion3: sharpness(hblur(g, 3), W, H) / s0, motion5: sharpness(hblur(g, 5), W, H) / s0, motion9: sharpness(hblur(g, 9), W, H) / s0, box3: sharpness(box(g, 3), W, H) / s0, shake, dark: sharpness(bright(g, 0.6), W, H) / s0, light: sharpness(bright(g, 1.3), W, H) / s0 });
}
const f = (x) => x.toFixed(2).padStart(5);
console.log('photo                    score   motion3 motion5 motion9  box3   shake  darker brighter   (ratios vs sharp original)');
for (const r of rows) console.log(`${r.n.padEnd(22)} ${r.s0.toFixed(0).padStart(7)}  ${f(r.motion3)}   ${f(r.motion5)}   ${f(r.motion9)}  ${f(r.box3)}  ${f(r.shake)}  ${f(r.dark)}  ${f(r.light)}`);
const max = (k) => Math.max(...rows.map((r) => r[k])), min = (k) => Math.min(...rows.map((r) => r[k]));
console.log(`\nworst-case (closest to "sharp"): motion3 ${f(max('motion3'))}  motion5 ${f(max('motion5'))}  motion9 ${f(max('motion9'))}  box3 ${f(max('box3'))}`);
console.log(`worst-case (closest to "blurry"): shake ${f(min('shake'))}  darker ${f(min('dark'))}  brighter ${f(min('light'))}`);
for (const ratio of [0.3, 0.4, 0.5, 0.6]) {
  const caught = (k) => rows.filter((r) => r[k] < ratio).length;
  const falseSkip = (k) => rows.filter((r) => r[k] < ratio).length;
  console.log(`ratio ${ratio}: motion blur caught 3px ${caught('motion3')}/${rows.length}, 5px ${caught('motion5')}/${rows.length}, 9px ${caught('motion9')}/${rows.length}, box3 ${caught('box3')}/${rows.length} | false skips: shake ${falseSkip('shake')}, darker ${falseSkip('dark')}, brighter ${falseSkip('light')}`);
}
