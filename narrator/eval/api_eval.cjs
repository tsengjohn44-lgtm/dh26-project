#!/usr/bin/env node
// Real-API prompt evaluation: sends test photos to Perceptron exactly as the server would
// (prompt.js buildPayload) and filters replies exactly as the phone would (filter.js classifyReply).
// Uses API credits: ~40 requests by default, about $0.01. Run it before and after any prompt change.
//
//   node narrator/eval/api_eval.cjs                       19 photos, 1 run each
//   node narrator/eval/api_eval.cjs --runs 3              repeat each photo (the model varies between runs)
//   node narrator/eval/api_eval.cjs --reasoning low       none | low | high (as the app's Reasoning setting)
//   node narrator/eval/api_eval.cjs --style classic       the pre-label prompt
//
// For every photo it checks:
//   rules     reply ≤ 12 words; no distances; step counts only for stairs
//   label     the hazard label the photo should get (trip / drop / none; 'any' = not graded)
//   repeat    the same photo again, with its own alert in "Already said", gives n/a or a repeat
// It prints every reply, then latency (median and worst), and saves everything to results/*.json.
const fs = require('fs'), path = require('path');
const NARRATOR = path.join(__dirname, '..');
const { buildPayload } = require(path.join(NARRATOR, 'prompt.js'));
const Filter = require(path.join(NARRATOR, 'public', 'filter.js'));
const PHOTOS = path.join(__dirname, 'photos');

// Expected label per photo, from the safety-prompt evaluation (AGENTS.md section 7).
// 'any' = ambiguous scene (both a hazard and no hazard are reasonable), shown but not graded.
const CASES = [
  ['stairs/up1', 'trip'], ['stairs/up2', 'trip'], ['stairs/up3', 'trip'],
  ['stairs/down0', 'drop'], ['stairs/down1', 'drop'], ['stairs/down2', 'drop'],
  ['eval768/curb', 'trip'], ['eval768/pothole', 'trip'], ['open2/door_glass', 'trip'],
  ['eval768/room_sign', 'none'], ['eval768/building_sign', 'none'], ['open2/door_open_doorway', 'none'], ['eval768/corridor', 'none'],
  ['open2/open_atrium', 'none'], ['open2/open_plaza', 'none'], ['open2/open_library', 'none'], ['open2/open_wide_archway', 'none'],
  ['eval768/cyclist', 'any'], ['eval768/crosswalk', 'any'],
];
// More than ~3 requests at once inflated latency (8 at once: ~6 s) and distorted the numbers.
const CONCURRENCY = 3;

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const RUNS = Math.max(1, Number(opt('--runs', 1)));
const REASONING = opt('--reasoning', 'none');
const STYLE = opt('--style', 'safety');
const MODEL = process.env.PERCEPTRON_MODEL || 'perceptron-mk1.5';

function apiKey() {
  if (process.env.PERCEPTRON_API_KEY) return process.env.PERCEPTRON_API_KEY;
  try { return fs.readFileSync(path.join(NARRATOR, '.env'), 'utf8').match(/^\s*PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/m)[1]; }
  catch { console.error('No PERCEPTRON_API_KEY (environment or narrator/.env).'); process.exit(2); }
}
const KEY = apiKey();

const missing = CASES.filter(([n]) => !fs.existsSync(path.join(PHOTOS, `${n}.jpg`)));
if (missing.length) { console.error(`Missing photos in eval/photos/: ${missing.map(([n]) => n).join(', ')} (see docs/testing-process.md)`); process.exit(2); }
const image = (name) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(PHOTOS, `${name}.jpg`)).toString('base64');

// One request, retried on network errors and 429/5xx (rate limits shouldn't fail the eval).
async function ask(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = performance.now();
    try {
      const r = await fetch('https://api.perceptron.inc/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload({ ...body, reasoning: REASONING, style: STYLE }, MODEL)),
      });
      if (r.ok) return { raw: ((await r.json()).choices?.[0]?.message?.content || '').trim(), ms: Math.round(performance.now() - t0) };
      if (r.status !== 429 && r.status < 500) return { raw: '', ms: 0, error: `HTTP ${r.status} ${(await r.text()).slice(0, 150)}` };
    } catch (e) { if (attempt === 2) return { raw: '', ms: 0, error: e.message }; }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  return { raw: '', ms: 0, error: 'gave up after 3 attempts' };
}

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const isStairs = (t) => /\b(stairs?|steps?|staircase|stairway)\b/i.test(t);
// Distances are banned (user requirement), except stair counts.
const DISTANCE_RE = /\b\d+(\.\d+)?\s*(m|metres?|meters?|feet|foot|ft|yards?|cm)\b/i;
const STEP_COUNT_RE = /\b\d+\s*steps?\b/i;

let pass = 0, total = 0;
const check = (name, ok, detail = '') => { total++; pass += !!ok; console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '   ' + detail}`); };

(async () => {
  console.log(`model ${MODEL} · reasoning ${REASONING} · style ${STYLE} · ${CASES.length} photos × ${RUNS} run(s) · ${CONCURRENCY} at once\n`);
  const jobs = []; for (let run = 0; run < RUNS; run++) for (const c of CASES) jobs.push({ run, name: c[0], want: c[1] });
  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let job; (job = jobs.shift());) {
      const img = image(job.name);
      const first = await ask({ image: img });
      const shown = first.error ? null : Filter.classifyReply(first.raw, []);
      // Same view again with its own alert in "Already said": must not be spoken twice.
      const again = shown?.text ? await ask({ image: img, said: [shown.text] }) : null;
      const againShown = again && !again.error ? Filter.classifyReply(again.raw, [shown.text]) : null;
      results.push({ ...job, first, shown, again, againShown });
    }
  }));
  results.sort((a, b) => CASES.findIndex((c) => c[0] === a.name) - CASES.findIndex((c) => c[0] === b.name) || a.run - b.run);

  for (const r of results) {
    const tag = `${r.name}${RUNS > 1 ? ` #${r.run + 1}` : ''}`;
    if (r.first.error) { check(`${tag}: request`, false, r.first.error); continue; }
    const text = r.shown.text || 'n/a';
    console.log(`\n## ${tag}  (want ${r.want}, ${r.first.ms} ms)\n   heard: ${text}${r.first.raw !== text ? `\n   model: ${r.first.raw}` : ''}`);
    check(`${tag}: ≤ 12 words`, words(text) <= 12, `${words(text)} words`);
    check(`${tag}: no distances`, !DISTANCE_RE.test(text), text);
    check(`${tag}: step count only for stairs`, !STEP_COUNT_RE.test(text) || isStairs(text), text);
    if (r.want !== 'any') {
      const got = r.shown.text ? Filter.hazardLabel(r.shown.text) || 'none' : 'none';
      check(`${tag}: label ${r.want}`, got === r.want, `got ${got}`);
    }
    if (r.again) {
      const heard = r.againShown ? (r.againShown.text || r.againShown.reason) : r.again.error;
      check(`${tag}: same view again → not spoken twice`, r.againShown && r.againShown.reason !== 'new', `would say: ${heard}`);
    }
  }

  const ms = results.flatMap((r) => [r.first.ms, r.again?.ms]).filter((v) => v > 0).sort((a, b) => a - b);
  const median = ms[ms.length >> 1], worst = ms[ms.length - 1];
  console.log(`\nlatency: median ${median} ms, worst ${worst} ms over ${ms.length} requests`);

  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const out = path.join(__dirname, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-api.json`);
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, reasoning: REASONING, style: STYLE, runs: RUNS, pass, total, latency: { median, worst, n: ms.length }, results }, null, 2));
  console.log(`replies saved: ${path.relative(process.cwd(), out)}`);
  console.log(`${pass}/${total}`);
})();
