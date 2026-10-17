// Capture loop: send a camera frame to /api/describe every `interval` ms, with up to
// MAX_IN_FLIGHT requests overlapping. Overlap matters because the model takes ~0.9 s per frame:
// waiting for each reply before capturing the next meant a scene change took ~2 s to show.
// Replies for frames older than one already shown are dropped.

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
const statusEl = $('status');
const latencyEl = $('latency');
const lensEl = $('lens');
const currentEl = $('current');
const liveEl = $('live');
const detEl = $('det');
const historyEl = $('history');
const startBtn = $('start');
const intervalInput = $('interval');
const intervalOut = $('intervalOut');

const MAX_SIDE = 768; // at 512 the model misread room numbers ("71A" as "714"); same latency
const JPEG_QUALITY = 0.7;
const HISTORY_LEN = 4;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_IN_FLIGHT = 3;       // the API answered 3 concurrent requests about as fast as 1
const MAX_SAID = 5;            // recent alerts sent back so the model doesn't repeat itself
const MAX_PREV_FRAME_AGE = 4000; // older previous frames are too stale to judge motion from
// Send the previous frame with the current one as a 2-frame clip so the model can judge motion.
// Off: in testing the model called static scenes "approaching" and misidentified cyclists as
// walkers when given clips, while single frames identified them correctly.
const MOTION_FRAMES = false;
// When a frame's thumbnail differs from the start of the current view by more than this
// (Filter.viewChange, 0 = same, ~1 = unrelated), the camera is looking somewhere new: forget
// what was "already said" so the new view gets described right away, and ignore replies still
// in flight for the old view. Tuned on photos: 0 false resets from shake/exposure, ~95% of
// different places detected.
const VIEW_CHANGE = 0.5;
const THUMB_W = 24, THUMB_H = 18;

// Fast tier, off unless the page is opened with ?detector=1: an on-device detector (detector.js)
// runs on every camera frame and keeps a live line such as "2 people ahead, chair on the left"
// (tracker.js), while Perceptron keeps reporting stairs, curbs, doors and text.
const params = new URLSearchParams(location.search);
const DETECTOR = params.get('detector') === '1';
// Lite2 float16 on GPU: the only model that found both the bike and its rider on the test photos
// (laptop benchmark: 41 ms/frame). ?model=lite0-f16 picks the lighter one.
const DETECTOR_MODEL = params.get('model') || 'lite2-f16';
const DETECT_FPS = 15;      // cap: plenty for walking speed, and saves battery and heat
const SLOW_DETECT_MS = 125; // slower than ~8 fps the live line lags behind: drop to Lite0
const SLOW_CHECK_FRAMES = 30;

let stream = null;
let facing = 'environment';
let running = false;
let runId = 0;              // bumps on every start/stop so stale loops and replies are ignored
const inFlight = new Set(); // AbortControllers of requests in progress
let sentSeq = 0;            // sequence number of the last frame sent
let shownSeq = 0;           // sequence number of the newest frame whose reply was handled
let pausedUntil = 0;        // back-off after errors / rate limits
let said = [];              // alerts shown for the current view, oldest first
let viewId = 0;             // bumps whenever the camera moves to a new view
let viewThumb = null;       // thumbnail of the frame that started the current view
let prevFrame = null;       // { image, size, t } paired with the next frame when MOTION_FRAMES
let wakeLock = null;
let detector = null;        // loaded once on the first Start with ?detector=1, kept across stops
let detectorLoading = null;
const tracker = DETECTOR ? Tracker.createTracker() : null;
const liveStable = DETECTOR ? Tracker.createStabilizer() : null;
let liveText = '';          // the live line on screen; Perceptron is told it was already said

// ---------- camera ----------

// 4:3 uses the whole sensor on most phone cameras; 16:9 crops the top and bottom off.
const CAMERA_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } };
const getCamera = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CAMERA_SIZE, ...video } });

async function openCamera() {
  stopCamera();
  stream = await getCamera({ facingMode: { ideal: facing } });
  if (facing === 'environment') await useWidestLens();
  video.srcObject = stream;
  await video.play();
  showLens();
}

// Prefer the ultra-wide lens for a bigger field of view. Browsers only expose it in some cases:
// iOS Safari lists it as "Back Ultra Wide Camera"; some Android phones instead allow zooming
// out below 1x. Otherwise the default back camera stays.
async function useWidestLens() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices(); // labels need camera permission
    const wide = devices.find((d) => d.kind === 'videoinput' && /ultra\s*-?\s*wide/i.test(d.label));
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (wide && wide.deviceId !== current) {
      stopCamera(); // phones generally allow only one open camera
      try {
        stream = await getCamera({ deviceId: { exact: wide.deviceId } });
      } catch {
        stream = await getCamera({ facingMode: { ideal: facing } });
      }
    }
  } catch { /* enumerateDevices unsupported: keep the default camera */ }

  try {
    const track = stream.getVideoTracks()[0];
    const zoom = track.getCapabilities?.().zoom;
    if (zoom && zoom.min < (track.getSettings().zoom ?? 1)) await track.applyConstraints({ advanced: [{ zoom: zoom.min }] });
  } catch { /* zoom unsupported */ }
}

function showLens() {
  const track = stream?.getVideoTracks()[0];
  const { width, height, zoom } = track?.getSettings() || {};
  const name = (track?.label || '').replace(/camera/i, '').trim();
  lensEl.textContent = [name, zoom && zoom !== 1 && `${zoom}×`, width && `${width}×${height}`].filter(Boolean).join(' · ');
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function grabFrame() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// Tiny grayscale copy of the frame just grabbed, for detecting a change of view.
function grabThumb() {
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = THUMB_H;
  thumbCtx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);
  const px = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const gray = new Float32Array(THUMB_W * THUMB_H);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return gray;
}

// Start a new view when the camera now sees something clearly different.
function checkViewChange() {
  const thumb = grabThumb();
  if (viewThumb && Filter.viewChange(viewThumb, thumb) <= VIEW_CHANGE) return;
  if (viewThumb) {
    viewId++;
    said = [];
    setStatus('Live · new view', true);
    // The old alert describes the old view: move it to history right away instead of
    // leaving it up (it would stay if the new view has nothing to report).
    if (currentEl.dataset.alert) pushHistory(currentEl.dataset.alert);
    delete currentEl.dataset.alert;
    currentEl.classList.remove('error');
    currentEl.textContent = 'Looking…';
  }
  viewThumb = thumb;
}

// ---------- requests ----------

class HttpError extends Error {
  constructor(message, retryAfterMs) { super(message); this.retryAfterMs = retryAfterMs; }
}

async function sendFrame(id) {
  const image = grabFrame();
  if (!image) return; // camera starting or switching
  checkViewChange();
  const t0 = performance.now();
  const seq = ++sentSeq;
  const view = viewId;
  const size = `${canvas.width}x${canvas.height}`;

  // Perceptron rejects clips whose frames differ in size (e.g. after the phone rotates).
  const body = { image, said: saidWithLive() };
  if (MOTION_FRAMES && prevFrame && prevFrame.size === size && t0 - prevFrame.t <= MAX_PREV_FRAME_AGE) {
    body.prevImage = prevFrame.image;
    body.prevDtMs = Math.round(t0 - prevFrame.t);
  }
  if (MOTION_FRAMES) prevFrame = { image, size, t: t0 };

  const controller = new AbortController();
  inFlight.add(controller);
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('/api/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new HttpError(await res.text(), retryAfter > 0 ? retryAfter * 1000 : 0);
    }
    const reply = await res.text();
    if (id !== runId) return;
    const apiMs = Number(res.headers.get('server-timing')?.match(/dur=([\d.]+)/)?.[1]);
    handleReply(seq, view, reply, performance.now() - t0, apiMs);
  } catch (e) {
    if (id !== runId) return; // stopped: aborts are expected
    pausedUntil = performance.now() + Math.max(2000, e.retryAfterMs || 0);
    setStatus('Error', false);
    currentEl.textContent = e.message || String(e);
    currentEl.classList.add('error');
  } finally {
    clearTimeout(timer);
    inFlight.delete(controller);
  }
}

function handleReply(seq, view, reply, totalMs, apiMs) {
  if (seq < shownSeq || view !== viewId) return; // a newer frame was answered, or the view changed
  shownSeq = seq;
  latencyEl.textContent = Number.isFinite(apiMs)
    ? `${Math.round(totalMs)} ms (model ${Math.round(apiMs)})`
    : `${Math.round(totalMs)} ms`;
  const wasError = currentEl.classList.contains('error');
  currentEl.classList.remove('error');

  // Filter (filter.js) drops "n/a" and restatements of what was already shown for this view,
  // including the detector's live line. It checks the current `said`, which may be newer than
  // the one this request was sent with.
  const { text, reason } = Filter.classifyReply(reply, saidWithLive());
  if (!text) {
    // Say why nothing changed: the model saw nothing new, or it repeated an earlier alert.
    setStatus(reason === 'repeat' ? 'Live · already said' : 'Live · nothing new', true);
    if (!currentEl.dataset.alert) currentEl.textContent = 'Nothing important in view.';
    else if (wasError) currentEl.textContent = currentEl.dataset.alert;
    return;
  }
  setStatus('Live', true);
  const shown = currentEl.dataset.alert;
  if (shown) pushHistory(shown);
  currentEl.textContent = text;
  currentEl.dataset.alert = text;
  said = [...said, text].slice(-MAX_SAID);
}

// What the person has been told: Perceptron's alerts for this view plus the detector's live line,
// so Perceptron doesn't repeat the people and chairs already on screen. MAX_SAID in total.
const saidWithLive = () => (liveText ? [...said.slice(-(MAX_SAID - 1)), liveText] : said);

function pushHistory(text) {
  const li = document.createElement('li');
  li.textContent = text;
  historyEl.prepend(li);
  while (historyEl.children.length > HISTORY_LEN) historyEl.lastChild.remove();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fast tier (?detector=1) ----------

async function startDetector(id) {
  if (!detector) {
    detEl.textContent = 'Detector loading…';
    detectorLoading ??= loadDetector(DETECTOR_MODEL);
    try {
      detector = await detectorLoading;
    } catch (e) {
      detectorLoading = null; // try again on the next Start
      detEl.textContent = 'Detector failed';
      console.warn('Detector failed to load', e);
      return;
    }
  }
  if (id !== runId) return;
  detectorLoop(id);
}

// GPU first; if this browser can't run it there, the int8 Lite0 model on CPU (wasm).
async function loadDetector(model) {
  try {
    return await Detector.createDetector({ model, delegate: 'GPU' });
  } catch (e) {
    console.warn('GPU detector unavailable, using CPU', e);
    return Detector.createDetector({ model: 'lite0', delegate: 'CPU' });
  }
}

let switchedModel = false;
async function useLighterModel() {
  if (switchedModel) return;
  switchedModel = true;
  try {
    const lighter = await loadDetector('lite0-f16');
    const old = detector;
    detector = lighter;
    old.close();
  } catch (e) { console.warn('Could not load the lighter detector', e); }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
// The front camera's frames aren't mirrored but the preview is: flip x so left means the person's left.
const mirror = (d) => ({ ...d, box: { ...d.box, x: 1 - d.box.x - d.box.w } });

// Runs the detector on the current camera frame DETECT_FPS times a second and keeps the live
// line current. A timer, not requestVideoFrameCallback: frame callbacks follow page painting,
// which browsers slow to ~1/s whenever the window isn't being drawn.
function detectorLoop(id) {
  const times = [], stamps = [];
  let frames = 0;
  const step = () => {
    if (!running || id !== runId) return;
    const now = performance.now();
    if (video.videoWidth) {
      let dets = [];
      try { dets = detector.detect(video, now); } catch (e) { console.warn('detect failed', e); }
      if (facing === 'user') dets = dets.map(mirror);
      showLive(liveStable.next(Tracker.summarize(tracker.update(dets, now)), now));

      times.push(performance.now() - now);
      stamps.push(now);
      if (times.length > SLOW_CHECK_FRAMES) { times.shift(); stamps.shift(); }
      if (++frames % 8 === 0) {
        const fps = (stamps.length - 1) / ((stamps[stamps.length - 1] - stamps[0]) / 1000);
        detEl.textContent = `${detector.model} ${detector.delegate} · ${Math.round(fps)} fps · ${Math.round(median(times))} ms`;
      }
      if (times.length === SLOW_CHECK_FRAMES && median(times) > SLOW_DETECT_MS && detector.model === 'lite2-f16') useLighterModel();
    }
    setTimeout(step, Math.max(0, 1000 / DETECT_FPS - (performance.now() - now)));
  };
  step();
}

function showLive(text) {
  if (text === liveText) return;
  liveText = text;
  liveEl.textContent = text;
  window.dispatchEvent(new CustomEvent('narrator:live', { detail: { text, t: performance.now() } }));
}

function resetLive() {
  tracker?.reset();
  liveStable?.reset();
  liveText = '';
  liveEl.textContent = '';
}

async function loop(id) {
  while (running && id === runId) {
    if (inFlight.size < MAX_IN_FLIGHT && performance.now() >= pausedUntil) sendFrame(id);
    await sleep(Number(intervalInput.value));
  }
}

// ---------- controls ----------

function setStatus(text, live) {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', !!live);
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    currentEl.textContent = 'Camera unavailable. Open this page over HTTPS (or localhost).';
    return;
  }
  try {
    await openCamera();
  } catch (e) {
    currentEl.textContent = `Camera error: ${e.message}`;
    return;
  }
  running = true;
  const id = ++runId;
  pausedUntil = 0;
  resetView();
  startBtn.textContent = 'Stop';
  startBtn.classList.add('running');
  setStatus('Starting…', true);
  currentEl.textContent = 'Looking…';
  requestWakeLock();
  loop(id);
  if (DETECTOR) startDetector(id);
}

// Treat whatever the camera sees next as a fresh view.
function resetView() {
  viewId++;
  viewThumb = null;
  said = [];
  prevFrame = null;
  resetLive(); // tracked objects belong to the old camera or run
}

function stop() {
  running = false;
  runId++;
  resetView();
  for (const c of inFlight) c.abort();
  inFlight.clear();
  stopCamera();
  releaseWakeLock();
  startBtn.textContent = 'Start';
  startBtn.classList.remove('running');
  setStatus('Idle', false);
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

startBtn.addEventListener('click', () => (running ? stop() : start()));

$('flip').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  video.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
  resetView(); // a different camera is a new view (and its frames aren't a clip with the old)
  if (stream) {
    try { await openCamera(); } catch (e) { currentEl.textContent = `Camera error: ${e.message}`; }
  }
});

const showInterval = () => { intervalOut.textContent = `${(Number(intervalInput.value) / 1000).toFixed(1)}s`; };
intervalInput.addEventListener('input', showInterval);
showInterval();

// Pause while the page is hidden; resume when it comes back.
let resumeOnShow = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) { resumeOnShow = true; stop(); }
  else if (!document.hidden && resumeOnShow) { resumeOnShow = false; start(); }
});
