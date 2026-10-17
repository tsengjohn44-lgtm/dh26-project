// Measures Perceptron's point annotations (vision_config.annotation_format: "point") before the
// spatial map (AGENTS.md section 11) relies on them: latency and token cost compared with the
// request the app sends today, whether points come back, the markup format, and where the
// points land. Each image is sent exactly as server.js would send it (prompt.js buildPayload),
// then with point output on top. Nothing here is used by the app.
//
// Usage: node eval/points.js <image-dir> [--reps 2] [--out results.json] [--html report.html]
//        node eval/points.js <image-dir> --from results.json [--html report.html]   (re-score, no API calls)
// The key comes from PERCEPTRON_API_KEY or narrator/.env. Images stay out of git: put .jpg/.png
// files (resized with `sips -Z 768`, like app frames) in any folder.

const fs = require('fs');
const path = require('path');
const { buildPayload } = require('../prompt');

const API_URL = 'https://api.perceptron.inc/v1/chat/completions';
const MODEL = process.env.PERCEPTRON_MODEL || 'perceptron-mk1.5';
const CONCURRENCY = 3; // AGENTS.md: 8 at once inflated latency to ~6 s; the app runs up to 3
const TIMEOUT_MS = 20000; // same as the app's REQUEST_TIMEOUT_MS
const MAX_WORDS = 12; // the prompt's limit, checked on the text with markup removed
const POINT_HINT = 'Mark each thing you mention with a point.';

// Variants to compare. `point-hint` checks whether the prompt must ask for points explicitly.
const MODES = {
  baseline: (p) => p,
  point: (p) => ({ ...p, vision_config: { annotation_format: 'point' } }),
  'point-hint': (p) => withHint({ ...p, vision_config: { annotation_format: 'point' } }),
};

function withHint(payload) {
  const messages = payload.messages.map((m) => (m.role !== 'user' ? m : {
    ...m,
    content: m.content.map((c) => (c.type === 'text' ? { ...c, text: `${c.text}\n\n${POINT_HINT}` } : c)),
  }));
  return { ...payload, messages };
}

function loadKey() {
  if (process.env.PERCEPTRON_API_KEY) return process.env.PERCEPTRON_API_KEY;
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/^\s*PERCEPTRON_API_KEY\s*=\s*(.*?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

function parseArgs(argv) {
  const args = { dir: null, reps: 2, out: null, html: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reps') args.reps = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--html') args.html = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else args.dir = a;
  }
  if (!args.dir || !(args.reps > 0)) {
    console.error('Usage: node eval/points.js <image-dir> [--reps 2] [--out results.json] [--html report.html] [--from results.json]');
    process.exit(1);
  }
  return args;
}

function loadImages(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort()
    .map((f) => {
      const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
      return { name: f.replace(/\.[^.]+$/, ''), dataUrl: `data:${mime};base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}` };
    });
}

// Point markup, per docs.perceptron.inc concepts/annotations:
//   <point mention="door" asset_idx="0"> (120,200) </point>
//   <collection mention="doors"> <point> (1,2) </point> <point> (3,4) </point> </collection>
// Coordinates are (x,y) on a 0-1000 grid, origin top-left. Points inside a collection without
// their own mention take the collection's.
const attr = (attrs, name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];

function parsePoints(text) {
  const points = [];
  const readPoints = (chunk, fallbackMention) => {
    for (const m of chunk.matchAll(/<point\b([^>]*)>\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*<\/point>/g)) {
      points.push({ mention: attr(m[1], 'mention') ?? fallbackMention ?? null, x: Number(m[2]), y: Number(m[3]) });
    }
  };
  const outside = text.replace(/<collection\b([^>]*)>([\s\S]*?)<\/collection>/g, (_, attrs, inner) => {
    readPoints(inner, attr(attrs, 'mention'));
    return ' ';
  });
  readPoints(outside, null);
  return points;
}

// Every tag name in the reply, to spot markup other than <point> / <collection>.
const tagNames = (text) => [...new Set([...text.matchAll(/<\/?([a-z_]+)\b/gi)].map((m) => m[1].toLowerCase()))];

// The alert a user would see once markup is removed. The model writes it two ways: as text with
// bare points after it ("Pothole close ahead <point> (477,595) </point>"), or entirely inside
// mentions with nothing outside (<point mention="Stairs down ahead, at least 15 steps"> ...).
// Use the outside text when there is any, otherwise the mentions.
const outsideText = (text) => text.replace(/<point\b[^>]*>[\s\S]*?<\/point>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function plainText(text) {
  return outsideText(text) || parsePoints(text).map((p) => p.mention).filter(Boolean).join('. ');
}
const wordCount = (text) => (text.match(/\S+/g) || []).length;
const isNA = (text) => text.toLowerCase().replace(/[^a-z]/g, '') === 'na';

async function call(key, payload) {
  const t0 = performance.now();
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort,
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ms, status: res.status, error: (await res.text()).slice(0, 300) };
    const json = await res.json();
    const choice = json.choices?.[0] || {};
    return { ms, status: 200, text: (choice.message?.content || '').trim(), finish: choice.finish_reason, usage: json.usage || {} };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), status: 0, error: e.message };
  }
}

async function runPool(jobs, worker) {
  const results = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await worker(jobs[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');

function summarize(results) {
  const rows = [];
  for (const mode of Object.keys(MODES)) {
    const all = results.filter((r) => r.mode === mode);
    const ok = all.filter((r) => r.status === 200);
    const answered = ok.filter((r) => !isNA(r.plain));
    rows.push({
      mode,
      calls: all.length,
      errors: all.length - ok.length,
      'median ms': Math.round(median(ok.map((r) => r.ms))),
      'max ms': Math.max(...ok.map((r) => r.ms)),
      'prompt tok': Math.round(mean(ok.map((r) => r.usage.prompt_tokens || 0))),
      'output tok': Math.round(mean(ok.map((r) => r.usage.completion_tokens || 0))),
      'n/a': pct(ok.length - answered.length, ok.length),
      'has points': pct(answered.filter((r) => r.points.length).length, answered.length),
      'text in mention': pct(answered.filter((r) => r.inMentions).length, answered.length),
      '>12 words': pct(answered.filter((r) => r.words > MAX_WORDS).length, answered.length),
      'cut off': ok.filter((r) => r.finish === 'length').length,
    });
  }
  return rows;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Self-contained page: each image with every point drawn on it, to judge accuracy by eye.
function htmlReport(images, results) {
  const colors = { point: '#ff2d55', 'point-hint': '#00c7ff', baseline: '#ffd400' };
  const cards = images.map((img) => {
    const rs = results.filter((r) => r.image === img.name && r.mode !== 'baseline' && r.status === 200);
    const dots = rs.flatMap((r) => r.points.map((p) => `<div class="dot" style="left:${p.x / 10}%;top:${p.y / 10}%;background:${colors[r.mode]}" title="${esc(`${r.mode} #${r.rep}: ${p.mention}`)}"><span>${esc(p.mention || '?')}</span></div>`));
    const lines = results.filter((r) => r.image === img.name).map((r) =>
      `<li><b style="color:${colors[r.mode]}">${r.mode} #${r.rep}</b> ${r.ms} ms: ${esc(r.status === 200 ? r.text : `ERROR ${r.status} ${r.error}`)}</li>`);
    return `<section><h2>${esc(img.name)}</h2><div class="frame"><img src="${img.dataUrl}">${dots.join('')}</div><ul>${lines.join('')}</ul></section>`;
  });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Point annotations</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}section{margin-bottom:32px}.frame{position:relative;display:inline-block;max-width:100%}
.frame img{display:block;max-width:100%}.dot{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #000}
.dot span{position:absolute;left:14px;top:-4px;white-space:nowrap;background:#000c;padding:0 4px;font-size:12px}li{margin:4px 0;font-family:ui-monospace,monospace;font-size:12px}</style>
<h1>Point annotations</h1><p>Red: point mode. Blue: point mode plus "${esc(POINT_HINT)}". Coordinates are 0-1000, origin top-left.</p>${cards.join('')}`;
}

// Derived fields, recomputed from the raw reply so saved results can be re-scored offline.
function score(r) {
  const text = r.text || '';
  const plain = plainText(text);
  const points = parsePoints(text);
  return { ...r, plain, words: wordCount(plain), points, tags: tagNames(text), inMentions: points.length > 0 && !outsideText(text) };
}

async function measure(images, reps) {
  const key = loadKey();
  if (!key) { console.error('Missing PERCEPTRON_API_KEY (environment or narrator/.env)'); process.exit(1); }
  // Interleave modes so a slow stretch of the API doesn't land on one mode only.
  const jobs = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const img of images) for (const mode of Object.keys(MODES)) jobs.push({ img, mode, rep });
  }
  console.log(`${images.length} images x ${Object.keys(MODES).length} modes x ${reps} reps = ${jobs.length} calls, ${CONCURRENCY} at a time`);
  const results = await runPool(jobs, async ({ img, mode, rep }) => {
    const r = await call(key, MODES[mode](buildPayload({ image: img.dataUrl, said: [] }, MODEL)));
    process.stdout.write(r.status === 200 ? '.' : 'x');
    return { image: img.name, mode, rep, ...r };
  });
  console.log('\n');
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = loadImages(args.dir);
  if (!images.length) { console.error(`No .jpg/.png images in ${args.dir}`); process.exit(1); }

  const raw = args.from ? JSON.parse(fs.readFileSync(args.from, 'utf8')) : await measure(images, args.reps);
  const results = raw.map(score);
  console.table(summarize(results));

  const seenTags = [...new Set(results.flatMap((r) => r.tags))];
  console.log(`Tags seen in replies: ${seenTags.join(', ') || 'none'}\n`);
  for (const r of results.filter((x) => x.mode !== 'baseline')) {
    const pts = r.points.map((p) => `${p.mention ?? '?'}@(${p.x},${p.y})`).join(' ');
    console.log(`${r.image.padEnd(14)} ${r.mode.padEnd(10)} #${r.rep} ${String(r.ms).padStart(5)} ms  ${r.status === 200 ? r.plain : `ERROR ${r.status}`}${pts ? `  [${pts}]` : ''}`);
  }

  if (args.out) fs.writeFileSync(args.out, JSON.stringify(results, null, 1));
  if (args.html) fs.writeFileSync(args.html, htmlReport(images, results));
}

main();
