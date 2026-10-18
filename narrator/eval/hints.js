// Measures whether the detector's summary, sent as `hints`, makes Perceptron's caption better, and
// whether a wrong hint misleads it. Frames are built the way the app builds them: the image fills a
// 4:3 camera-sized frame (cropped like a real camera), the detector runs on that, and Perceptron
// gets it scaled to 768 px as JPEG q0.7. Results are left on window.__hints for scripted runs.

const $ = (id) => document.getElementById(id);
const FRAME_W = 1920, FRAME_H = 1440; // the app's camera request
const MAX_SIDE = 768, JPEG_QUALITY = 0.7; // same as app.js grabFrame()
const REPS = 3;
const CONCURRENCY = 3; // the app's MAX_IN_FLIGHT; more at once inflates latency (AGENTS.md section 8)
const DETECT_FRAMES = 3; // the tracker confirms an object after 2 frames
// Something none of the test images contain, to see whether the model repeats a wrong hint.
const WRONG_HINT = 'Dog close ahead.';
const MODES = ['none', 'hint', 'wrong'];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const words = (t) => (t.match(/\S+/g) || []).length;
const isNA = (t) => t.toLowerCase().replace(/[^a-z]/g, '') === 'na';
const setStatus = (t) => { $('status').textContent = t; };

async function cameraFrame(file) {
  const img = await createImageBitmap(await (await fetch(`/eval/images/${encodeURIComponent(file)}`)).blob());
  // A phone held upright gives portrait frames (1440x1920), so portrait photos get a portrait frame.
  const [fw, fh] = img.height > img.width ? [FRAME_H, FRAME_W] : [FRAME_W, FRAME_H];
  const frame = document.createElement('canvas');
  frame.width = fw;
  frame.height = fh;
  const s = Math.max(fw / img.width, fh / img.height); // cover, like a camera
  frame.getContext('2d').drawImage(img, (fw - img.width * s) / 2, (fh - img.height * s) / 2, img.width * s, img.height * s);
  const small = document.createElement('canvas');
  const scale = Math.min(1, MAX_SIDE / Math.max(fw, fh));
  small.width = Math.round(fw * scale);
  small.height = Math.round(fh * scale);
  small.getContext('2d').drawImage(frame, 0, 0, small.width, small.height);
  return { name: file.replace(/\.[^.]+$/, ''), frame, jpeg: small.toDataURL('image/jpeg', JPEG_QUALITY) };
}

async function loadDetector() {
  try { return await Detector.createDetector({ model: 'lite0-f16', delegate: 'GPU' }); }
  catch { return Detector.createDetector({ model: 'lite0', delegate: 'CPU' }); }
}

function detectorHint(det, frame) {
  const tracker = Tracker.createTracker();
  let tracks = [];
  for (let i = 0; i < DETECT_FRAMES; i++) tracks = tracker.update(det.detect(frame, performance.now() + i), i * 66);
  return Tracker.summarize(tracks);
}

async function describe(image, hints) {
  const t0 = performance.now();
  const res = await fetch('/api/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hints ? { image, said: [], hints } : { image, said: [] }),
  });
  const body = (await res.text()).trim();
  return {
    status: res.status,
    text: res.ok ? body : `ERROR ${res.status}`, // a 429 body is a whole HTML page

    totalMs: performance.now() - t0,
    modelMs: Number(res.headers.get('server-timing')?.match(/dur=([\d.]+)/)?.[1]),
  };
}

async function pool(jobs, worker) {
  let next = 0, done = 0;
  const out = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await worker(jobs[i]);
      setStatus(`Perceptron calls: ${++done}/${jobs.length}`);
    }
  }));
  return out;
}

function summarize(results) {
  return MODES.map((mode) => {
    const ok = results.filter((r) => r.mode === mode && r.status === 200);
    const answered = ok.filter((r) => !isNA(r.text));
    return {
      mode,
      calls: ok.length,
      modelMs: Math.round(median(ok.map((r) => r.modelMs))),
      totalMs: Math.round(median(ok.map((r) => r.totalMs))),
      words: answered.length ? (answered.reduce((a, r) => a + words(r.text), 0) / answered.length).toFixed(1) : '-',
      over12: answered.filter((r) => words(r.text) > 12).length,
      na: ok.length - answered.length,
      dog: ok.filter((r) => /\bdogs?\b/i.test(r.text)).length,
    };
  });
}

function render(frames, results, rows) {
  const sbody = $('summary').querySelector('tbody');
  sbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.mode, r.calls, r.modelMs, r.totalMs, r.words, r.over12, r.na, r.dog]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    sbody.append(tr);
  }
  const dbody = $('detail').querySelector('tbody');
  dbody.textContent = '';
  for (const f of frames) {
    const tr = document.createElement('tr');
    const cells = [f.name, f.hint || '(none)', ...MODES.map((m) => results.filter((r) => r.image === f.name && r.mode === m).map((r) => r.text).join(' | '))];
    for (const v of cells) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    dbody.append(tr);
  }
  $('summary').hidden = $('detail').hidden = false;
  $('result').value = [
    ...rows.map((r) => `hints ${r.mode} | ${r.calls} calls | model ${r.modelMs} ms | total ${r.totalMs} ms | ${r.words} words | >12 words ${r.over12} | n/a ${r.na} | says dog ${r.dog}`),
    ...frames.map((f) => `${f.name} | hint: ${f.hint || '(none)'}\n${MODES.map((m) => `  ${m}: ${results.filter((r) => r.image === f.name && r.mode === m).map((r) => r.text).join(' | ')}`).join('\n')}`),
  ].join('\n');
}

async function run() {
  $('run').disabled = true;
  try {
    setStatus('Loading images and detector…');
    const names = await (await fetch('/eval/images/')).json();
    if (!names.length) throw new Error('No test images. Start the server with EVAL=1 EVAL_IMAGES=<folder>.');
    const det = await loadDetector();
    const frames = [];
    for (const file of names) {
      const f = await cameraFrame(file);
      f.hint = detectorHint(det, f.frame);
      frames.push(f);
    }
    det.close();
    const jobs = [];
    for (let rep = 1; rep <= REPS; rep++) for (const f of frames) for (const mode of MODES) jobs.push({ f, mode, rep });
    const results = await pool(jobs, async ({ f, mode, rep }) => {
      const hints = mode === 'hint' ? f.hint : mode === 'wrong' ? WRONG_HINT : '';
      return { image: f.name, mode, rep, hint: hints, ...(await describe(f.jpeg, hints)) };
    });
    const rows = summarize(results);
    render(frames, results, rows);
    window.__hints = { detector: `${det.model} ${det.delegate}`, frames: frames.map((f) => ({ name: f.name, hint: f.hint })), results, rows, done: true };
    setStatus('Done.');
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
    window.__hints = { error: String(e.message || e), done: true };
  } finally {
    $('run').disabled = false;
  }
}

$('run').addEventListener('click', run);
