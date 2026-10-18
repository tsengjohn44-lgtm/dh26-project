const fs = require('fs'), path = require('path');
const { buildPayload, finalizeReply, isRepeat } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const dir = process.argv[4];
const url = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, f + '.jpg')).toString('base64');

async function call(body) {
  const t0 = performance.now();
  const r = await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(body, 'perceptron-mk1.5')) });
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) return { raw: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`, final: null, ms, err: true };
  const raw = (await r.json()).choices?.[0]?.message?.content || '';
  return { raw, final: finalizeReply(raw, body.said), ms };
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const show = (r) => (r.err ? r.raw : r.raw === r.final ? r.final : `${r.final}   (model said: ${r.raw})`);

// Backstop unit checks
const unit = [
  [isRepeat('Stairs down, 4 steps ahead.', ['Stairs down, 5 steps ahead. Bottle on right step.']), true],
  [isRepeat('Stairs down, 1 step ahead.', ['Stairs down, 5 steps ahead.']), false],
  [isRepeat('People walking ahead, 8 steps.', ['People walking ahead, 10 steps.']), true],
  [isRepeat('Car approaching fast from left.', ['Car parked on left.']), false],
  [isRepeat('Door on right, sign reads "Room 215".', ['Door on right, sign reads "Room 214".']), false],
];
console.log('backstop unit checks:', unit.map(([a, b]) => (a === b ? '✓' : '✗')).join(' '));

(async () => {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4)).sort();
  const firsts = {};
  for (const n of names) firsts[n] = await call({ image: url(n) });
  const rows = [];
  for (let i = 0; i < names.length; i += 2) {
    rows.push(...await Promise.all(names.slice(i, i + 2).map(async (n) => {
      const other = names[(names.indexOf(n) + 1) % names.length];
      const first = firsts[n];
      const said1 = first.final && first.final !== 'n/a' ? [first.final] : [];
      const same = await call({ image: url(n), prevImage: url(n), prevDtMs: 1000, said: said1 });
      const otherSaid = firsts[other].final && firsts[other].final !== 'n/a' ? [firsts[other].final] : [];
      const changed = await call({ image: url(n), said: otherSaid });
      return { n, first, same, changed, said1 };
    })));
  }
  let ok = 0, tot = 0; const lat = [];
  for (const { n, first, same, changed, said1 } of rows) {
    const alert = (r) => !r.err && r.final !== 'n/a' && words(r.final) <= 12;
    const c1 = alert(first), c2 = !same.err && (same.final === 'n/a' || !said1.length), c3 = alert(changed);
    ok += c1 + c2 + c3; tot += 3; lat.push(first.ms, same.ms, changed.ms);
    console.log(`\n## ${n}`);
    console.log(`  ${c1 ? '✓' : '✗'} fresh   ${first.ms}ms: ${show(first)}`);
    console.log(`  ${c2 ? '✓' : '✗'} same    ${same.ms}ms: ${show(same)}`);
    console.log(`  ${c3 ? '✓' : '✗'} changed ${changed.ms}ms: ${show(changed)}`);
  }
  lat.sort((a, b) => a - b);
  console.log(`\nchecks passed: ${ok}/${tot}   latency median ${lat[lat.length >> 1]}ms  max ${lat[lat.length - 1]}ms`);
})();
