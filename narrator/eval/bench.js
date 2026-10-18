// Step 0 of the detector plan: how fast each on-device detector runs in this browser, and what
// it finds on the test images. Times only the detect() call, on frames the size the app asks the
// camera for, so the numbers carry over to the app's fast tier. Results are also left on
// window.__bench for scripted runs.

const $ = (id) => document.getElementById(id);
const FRAMES = 100;            // timed frames per detector, after one warm-up frame
const FRAME_W = 1920, FRAME_H = 1440; // the app's camera request (4:3 uses the full sensor)
// The GPU delegate only works with float16 models (int8 on GPU returned no detections).
const CONFIGS = [
  { model: 'lite0-f16', delegate: 'GPU', on: true },
  { model: 'lite0-f16', delegate: 'CPU', on: true },
  { model: 'lite0', delegate: 'CPU', on: true },
  { model: 'lite2-f16', delegate: 'GPU', on: true },
  { model: 'lite2', delegate: 'CPU', on: false },
];
const DET_SCORE_MIN = 0.35; // same as detector.js, listed with the results for reference
// A detector that hasn't loaded by then is reported as failed and the next one runs. On iPhone
// Safari, Lite2 on GPU stayed at "Loading…" with nothing to show for the runs before it.
const LOAD_TIMEOUT_MS = 45000;

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not load within ${ms / 1000} s`)), ms)),
]);

const name = (c) => `${c.model} ${c.delegate}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
const nextFrame = (video) => new Promise((r) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => r()) : requestAnimationFrame(() => r())));

function describeEnv() {
  const gl = !!document.createElement('canvas').getContext('webgl2');
  const env = `${navigator.userAgent} | WebGPU ${navigator.gpu ? 'yes' : 'no'} | WebGL2 ${gl ? 'yes' : 'no'} | cores ${navigator.hardwareConcurrency || '?'} | MediaPipe ${Detector.MP_VERSION}`;
  $('env').textContent = env;
  return env;
}

function renderConfigs() {
  for (const c of CONFIGS) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = c.on;
    box.addEventListener('change', () => { c.on = box.checked; });
    label.append(box, ` EfficientDet-${name(c)}`);
    $('configs').append(label);
  }
}

// Test images letterboxed onto a camera-sized canvas, so resize cost matches real frames.
async function loadImageFrames() {
  const names = await (await fetch('/eval/images/')).json();
  if (!names.length) throw new Error('No test images. Start the server with EVAL=1 EVAL_IMAGES=<folder>.');
  return Promise.all(names.map(async (file) => {
    // createImageBitmap, not img.decode(): decode() never settled in a page that wasn't painting.
    const img = await createImageBitmap(await (await fetch(`/eval/images/${encodeURIComponent(file)}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d');
    const scale = Math.min(FRAME_W / img.width, FRAME_H / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    ctx.drawImage(img, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h);
    return { file: file.replace(/\.[^.]+$/, ''), canvas };
  }));
}

async function openCamera() {
  const video = $('video');
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: FRAME_W }, height: { ideal: FRAME_H }, aspectRatio: { ideal: 4 / 3 } },
  });
  video.hidden = false;
  await video.play();
  return video;
}

async function benchOne(config, source) {
  const t0 = performance.now();
  let det;
  try {
    det = await withTimeout(Detector.createDetector(config), LOAD_TIMEOUT_MS, name(config));
  } catch (e) {
    return { name: name(config), error: e.message || String(e) };
  }
  const loadMs = performance.now() - t0;

  const frameAt = (i) => (source.video ? source.video : source.images[i % source.images.length].canvas);
  let t = performance.now();
  const firstMs = (() => { const s = performance.now(); det.detect(frameAt(0), t); return performance.now() - s; })();

  const times = [];
  const found = {}; // image -> detections from the first pass (images mode)
  for (let i = 0; i < FRAMES; i++) {
    if (source.video) await nextFrame(source.video);
    const frame = frameAt(i);
    t = performance.now();
    const dets = det.detect(frame, t);
    times.push(performance.now() - t);
    if (source.images && i < source.images.length) found[source.images[i].file] = dets;
    if (i % 10 === 9) { setStatus(`${name(config)}: ${i + 1}/${FRAMES}`); await new Promise((r) => setTimeout(r)); }
  }
  det.close();
  const med = median(times);
  return { name: name(config), loadMs, firstMs, medianMs: med, p90Ms: p90(times), maxFps: 1000 / med, found };
}

function setStatus(text) { $('status').textContent = text; }

function cdnMegabytes() {
  const bytes = performance.getEntriesByType('resource')
    .filter((e) => /jsdelivr|googleapis/.test(e.name))
    .reduce((sum, e) => sum + (e.transferSize || 0), 0);
  return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : 'n/a (cached or no timing headers)';
}

function report(env, sourceName, rows) {
  const tbody = $('table').querySelector('tbody');
  tbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = r.error ? [r.name, `failed: ${r.error}`, '', '', '', ''] : [r.name, r.loadMs, r.firstMs, r.medianMs, r.p90Ms, r.maxFps].map((v, i) => (i ? Math.round(v) : v));
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
    tbody.append(tr);
  }
  $('table').hidden = false;
  const lines = rows.map((r) => (r.error
    ? `bench ${sourceName} | ${r.name} | FAILED ${r.error}`
    : `bench ${sourceName} | ${r.name} | load ${Math.round(r.loadMs)} ms | first ${Math.round(r.firstMs)} ms | median ${r.medianMs.toFixed(1)} ms | p90 ${r.p90Ms.toFixed(1)} ms | ~${Math.round(r.maxFps)} fps`));
  $('result').value = [...lines, `downloaded from CDN: ${cdnMegabytes()}`, `env: ${env}`].join('\n');

  const det = rows.filter((r) => r.found && Object.keys(r.found).length).map((r) => `${r.name}\n${Object.entries(r.found).map(([file, ds]) =>
    `  ${file.padEnd(14)} ${ds.map((d) => `${d.label} ${d.score.toFixed(2)}`).join(', ') || '-'}`).join('\n')}`);
  $('dets').textContent = det.length ? `Detections (score ≥ ${DET_SCORE_MIN}):\n${det.join('\n')}` : '';
  window.__bench = { env, source: sourceName, rows, downloaded: cdnMegabytes() };
}

async function run(sourceName) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  const env = describeEnv();
  try {
    setStatus(sourceName === 'camera' ? 'Opening camera…' : 'Loading test images…');
    const source = sourceName === 'camera' ? { video: await openCamera() } : { images: await loadImageFrames() };
    const rows = [];
    const todo = CONFIGS.filter((x) => x.on);
    for (const [i, c] of todo.entries()) {
      setStatus(`Loading ${name(c)} (${i + 1} of ${todo.length})…`);
      rows.push(await benchOne(c, source));
      report(env, sourceName, rows); // show each result as it lands, not only at the end
    }
    window.__bench.done = true;
    setStatus('Done.');
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
    window.__bench = { error: String(e.message || e) };
  } finally {
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

renderConfigs();
describeEnv();
$('runCamera').addEventListener('click', () => run('camera'));
$('runImages').addEventListener('click', () => run('images'));
