const fs = require('fs');
const OLD = require(process.argv[2]), NEW = require(process.argv[3]);
const KEY = fs.readFileSync(process.argv[4], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const S = process.argv[5];
// expected label per photo: trip | drop | none | any (ambiguous scene)
const cases = [
  ['stairs/up1', 'trip'], ['stairs/up2', 'trip'], ['stairs/up3', 'trip'], ['stairs/down0', 'drop'], ['stairs/down1', 'drop'], ['stairs/down2', 'drop'],
  ['eval768/curb', 'trip'], ['eval768/pothole', 'trip'], ['open2/door_glass', 'trip'],
  ['eval768/room_sign', 'none'], ['eval768/building_sign', 'none'], ['open2/door_open_doorway', 'none'], ['eval768/corridor', 'none'],
  ['open2/open_atrium', 'none'], ['open2/open_plaza', 'none'], ['open2/open_library', 'none'], ['open2/open_wide_archway', 'none'],
  ['eval768/cyclist', 'any'], ['eval768/crosswalk', 'any'],
];
const label = (t) => { const m = t.match(/^\s*(trip hazard|drop[- ]?off|head hazard|moving hazard|obstacle)\b/i); if (!m) return 'none'; const k = m[1].toLowerCase(); return k.startsWith('trip') ? 'trip' : k.startsWith('drop') ? 'drop' : k.startsWith('head') ? 'head' : k.startsWith('moving') ? 'moving' : 'obstacle'; };
const words = (t) => t.split(/\s+/).filter(Boolean).length;
async function ask(mod, img) {
  for (let a = 0; a < 3; a++) {
    const t0 = performance.now();
    const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(mod.buildPayload({ image: img }, 'perceptron-mk1.5')) });
    const txt = await r.text();
    try { return { text: (JSON.parse(txt).choices[0].message.content || '').trim().replace(/\s+/g, ' '), ms: performance.now() - t0 }; } catch { await new Promise((s) => setTimeout(s, 1500)); }
  }
  return { text: 'ERROR', ms: 0 };
}
(async () => {
  const res = { old: [], new: [] }; const lines = {};
  const queue = cases.map((c) => c);
  await Promise.all([1, 2, 3].map(async () => { for (let c; (c = queue.shift());) {
    const [name, want] = c; const img = 'data:image/jpeg;base64,' + fs.readFileSync(`${S}/${name}.jpg`).toString('base64');
    for (const [k, mod] of [['old', OLD], ['new', NEW]]) for (let i = 0; i < 2; i++) {
      const r = await ask(mod, img); const nothing = /^n\/?a\.?$/i.test(r.text);
      res[k].push({ name, want, got: nothing ? 'n/a' : label(r.text), w: words(r.text), ms: r.ms, text: r.text });
      (lines[name] ||= { old: new Set(), new: new Set() })[k].add(r.text);
    }
  } }));
  for (const [name, want] of cases) console.log(`## ${name.split('/')[1]} (want ${want})\n  old: ${[...lines[name].old].join('  ||  ')}\n  new: ${[...lines[name].new].join('  ||  ')}`);
  for (const k of ['old', 'new']) {
    const R = res[k];
    const graded = R.filter((r) => r.want !== 'any');
    const correct = graded.filter((r) => r.want === 'none' ? (r.got === 'none' || r.got === 'n/a') : r.got === r.want).length;
    const hazardPhotos = R.filter((r) => r.want === 'trip' || r.want === 'drop');
    const labelled = hazardPhotos.filter((r) => r.got !== 'none' && r.got !== 'n/a').length;
    const falseHaz = R.filter((r) => r.want === 'none' && r.got !== 'none' && r.got !== 'n/a');
    const over12 = R.filter((r) => r.w > 12).length;
    const ms = R.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`\n== ${k.toUpperCase()} prompt: exact expected label ${correct}/${graded.length} · hazard photos labelled ${labelled}/${hazardPhotos.length} · labels on non-hazard photos ${falseHaz.length}/${R.filter((r) => r.want === 'none').length}${falseHaz.length ? ' (' + falseHaz.map((r) => r.name.split('/')[1] + ':' + r.got).join(', ') + ')' : ''} · >12 words ${over12}/${R.length} · median ${Math.round(ms[ms.length >> 1])} ms`);
  }
})();
