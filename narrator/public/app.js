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
const voiceEl = $('voiceStatus');
const voiceBox = $('voice');
const interruptBox = $('interrupt');
const currentEl = $('current');
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

// ---------- camera ----------

// 4:3 uses the whole sensor on most phone cameras; 16:9 crops the top and bottom off.
const CAMERA_SIZE = { width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } };
const getCamera = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CAMERA_SIZE, ...video } });

// Bumped by stopCamera(). A camera that finishes opening after a newer stop/reopen is closed
// at once instead of being kept: otherwise it would stay on with nothing showing or stopping it.
let cameraToken = 0;
async function openStream(constraints) {
  const token = cameraToken;
  const s = await getCamera(constraints);
  if (token !== cameraToken) { s.getTracks().forEach((t) => t.stop()); throw new Error('camera reopened'); }
  return s;
}

async function openCamera() {
  stopCamera();
  try {
    stream = await openStream({ facingMode: { ideal: facing } });
    if (facing === 'environment') await useWidestLens();
  } catch (e) {
    if (e.message === 'camera reopened') return; // superseded by a newer stop/reopen
    throw e;
  }
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
        stream = await openStream({ deviceId: { exact: wide.deviceId } });
      } catch (e) {
        if (e.message === 'camera reopened') throw e;
        stream = await openStream({ facingMode: { ideal: facing } });
      }
    }
  } catch (e) {
    if (e.message === 'camera reopened') throw e; // superseded: let openCamera() give up
    /* enumerateDevices unsupported: keep the default camera */
  }

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
  cameraToken++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function grabFrame() {
  if (!stream) return null; // camera (re)opening: the video may still hold a stale frame
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
  const body = { image, said };
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

  // Filter (filter.js) drops "n/a" and restatements of what was already shown for this view.
  // It checks the current `said`, which may be newer than the one this request was sent with.
  const { text, reason } = Filter.classifyReply(reply, said);
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
  Speech.say(text);
}

function pushHistory(text) {
  const li = document.createElement('li');
  li.textContent = text;
  historyEl.prepend(li);
  while (historyEl.children.length > HISTORY_LEN) historyEl.lastChild.remove();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------- screen orientation ----------
// Tilting the phone (e.g. pointing it at the ground) can make Android rotate the screen 180°.
// Android doesn't report a 180° turn like other rotations (width and height stay the same),
// so Chrome can keep drawing the camera at the old angle: the preview, and the frames sent
// to the model, end up upside down. Locking the screen to portrait prevents the rotation.
// Chrome only allows the lock in fullscreen, so phones go fullscreen on Start.
const isPhone = matchMedia('(pointer: coarse)').matches;

function lockPortrait() {
  if (!isPhone || !document.documentElement.requestFullscreen || !screen.orientation?.lock) return;
  const enter = document.fullscreenElement ? Promise.resolve() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  enter.then(() => screen.orientation.lock('portrait-primary'))
    .catch(() => { /* not allowed here (e.g. iOS, no tap): the fallbacks below cover it */ });
}

function unlockPortrait() {
  try { screen.orientation?.unlock(); } catch { /* unsupported */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Fullscreen ends if the camera permission prompt, a back swipe or an app switch interrupts
// it. The next tap anywhere (except Start/Stop, which would flicker) locks again.
document.addEventListener('pointerdown', (e) => {
  if (running && !document.fullscreenElement && !startBtn.contains(e.target)) lockPortrait();
});

// Reopen the camera, one reopen at a time.
let cameraBusy = Promise.resolve();
function reopenCamera() {
  cameraBusy = cameraBusy
    .then(() => (running || stream ? openCamera() : null))
    .catch((e) => { currentEl.textContent = `Camera error: ${e.message}`; });
  return cameraBusy;
}

// Fallback when the lock isn't in effect: after a 180° screen turn, reopen the camera so the
// browser sets up its rotation again.
let lastAngle = screen.orientation?.angle ?? 0;
screen.orientation?.addEventListener('change', () => {
  const angle = screen.orientation.angle;
  const turnedOver = Math.abs(angle - lastAngle) === 180;
  lastAngle = angle;
  if (!turnedOver || !running) return;
  resetView(); // the old frames were upside down; describe the view afresh
  reopenCamera();
});

async function start() {
  Speech.unlock(); // must happen synchronously in the Start tap, before any await (iOS)
  lockPortrait();  // also needs the tap: fullscreen + portrait lock (Android). After unlock():
                   // requestFullscreen uses up the tap, and unlock() still needs it.
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
  if (!stream) return; // Stop was tapped while the camera was opening
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
}

// Treat whatever the camera sees next as a fresh view.
function resetView() {
  viewId++;
  viewThumb = null;
  said = [];
  prevFrame = null;
}

function stop() {
  running = false;
  runId++;
  resetView();
  for (const c of inFlight) c.abort();
  inFlight.clear();
  Speech.cancel();
  stopCamera();
  releaseWakeLock();
  unlockPortrait();
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
  if (stream) await reopenCamera();
});

// ---------- voice ----------

const loadPref = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
const savePref = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage blocked */ } };

voiceBox.checked = loadPref('voice', true);
interruptBox.checked = loadPref('interrupt', false);
Speech.enabled = voiceBox.checked;
Speech.interrupt = interruptBox.checked;

voiceBox.addEventListener('change', () => {
  Speech.unlock(); // a tap: also a chance to unlock audio on iOS
  Speech.enabled = voiceBox.checked;
  savePref('voice', voiceBox.checked);
  renderVoice();
});
interruptBox.addEventListener('change', () => {
  Speech.interrupt = interruptBox.checked;
  savePref('interrupt', interruptBox.checked);
});

function renderVoice() {
  const { delayMs, lastError } = Speech.stats;
  if (!Speech.enabled) {
    if (lastError && voiceBox.checked) voiceBox.checked = false; // server has no ElevenLabs key
    voiceEl.textContent = lastError ? `voice off: ${lastError.slice(0, 60)}` : '';
    return;
  }
  const waiting = Math.max(0, Speech.pending - 1);
  voiceEl.textContent = lastError
    ? `voice error: ${lastError.slice(0, 60)}`
    : [delayMs && `voice starts in ${delayMs} ms`, waiting && `${waiting} queued`].filter(Boolean).join(' · ');
}
Speech.onChange = renderVoice;

const showInterval = () => { intervalOut.textContent = `${(Number(intervalInput.value) / 1000).toFixed(1)}s`; };
intervalInput.addEventListener('input', showInterval);
showInterval();

// Pause while the page is hidden; resume when it comes back.
let resumeOnShow = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) { resumeOnShow = true; stop(); }
  else if (!document.hidden && resumeOnShow) { resumeOnShow = false; start(); }
});
