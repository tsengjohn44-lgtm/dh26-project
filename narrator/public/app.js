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
  watchFrames(); // diagnostics only: no-op unless the 🐞 overlay is on
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
  stopFrameWatch();
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
  if (debugMode) detectBrowserFlip();
  if (frameTurn === 180) ctx.setTransform(-1, 0, 0, -1, canvas.width, canvas.height); // undo the browser's half-turn
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  if (debugMode) $('debugFrame').src = image; // exactly what Perceptron is sent
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

// While an alert is being spoken (or waiting to be), no new frames are sent: the user hears
// each alert in full before the app looks again. Requests already in flight still finish.
// Trade-off: nothing new is detected during speech (typically 2-3 s per alert).
const PAUSE_WHILE_SPEAKING = true;
const speaking = () => PAUSE_WHILE_SPEAKING && Speech.enabled && Speech.pending > 0;

async function loop(id) {
  while (running && id === runId) {
    if (speaking()) {
      if (!statusEl.textContent.includes('speaking')) setStatus('Live · paused while speaking', true);
    } else if (inFlight.size < MAX_IN_FLIGHT && performance.now() >= pausedUntil) {
      sendFrame(id);
    }
    await sleep(speaking() ? 100 : Number(intervalInput.value)); // resume promptly when speech ends
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
  if (!isPhone) return setLockState('skipped: not a touch device');
  if (!document.documentElement.requestFullscreen) return setLockState('unsupported: no fullscreen API');
  if (!screen.orientation?.lock) return setLockState('unsupported: no screen.orientation.lock');
  const enter = document.fullscreenElement ? Promise.resolve() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  // Lock only after fullscreen has fully taken effect (locking earlier can be refused).
  enter.then(() => screen.orientation.lock('portrait-primary'))
    .then(() => setLockState('locked portrait-primary'))
    .catch((e) => setLockState(`failed: ${e.name}: ${e.message}`)); // fallbacks below cover it
}

function unlockPortrait() {
  try { screen.orientation?.unlock(); } catch { /* unsupported */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Fullscreen ends if the camera permission prompt, a back swipe or an app switch interrupts
// it. The next tap anywhere (except Start/Stop, which would flicker) locks again. 'click',
// not 'pointerdown': on touch screens a tap only counts for fullscreen once the finger lifts
// (pointerdown gave "TypeError: Permissions check failed" on Android Edge).
document.addEventListener('click', (e) => {
  if (running && !document.fullscreenElement && !startBtn.contains(e.target)) lockPortrait();
});

// ---------- flip correction (Android) ----------
// Seen on Android Edge with the screen locked upright: when the phone's top edge dips below its
// bottom edge (lying flat, or aiming at the ground), the browser turns the camera image 180°,
// both the preview and the frames sent to the AI, and turns it back when the phone is lifted.
// It reports this nowhere (frame rotation tag stays 0°, screen angle stays 0°), so the app
// predicts it from gravity and turns the image back itself.
// Assumed tipping point: gravity y (along the phone's long edge) crossing 0. The 🐞 overlay logs
// the gravity at every flip it sees in the picture, to check this.
const FLIP_CORRECTION = /Android/i.test(navigator.userAgent);
const FLIP_ON_Y = -0.5;  // m/s²: top edge below bottom edge by this much: image is flipped
const FLIP_OFF_Y = 0.5;  // and back above it by this much: not flipped (gap avoids chatter)
let frameTurn = 0;       // 0 or 180: rotation the app applies to undo the browser's

function updateFrameTurn(x, y) {
  if (!FLIP_CORRECTION || Math.abs(x) > Math.abs(y)) return; // on its side: not this case
  const next = frameTurn === 180 ? (y > FLIP_OFF_Y ? 0 : 180) : (y < FLIP_ON_Y ? 180 : 0);
  if (next === frameTurn) return;
  frameTurn = next;
  applyPreviewTransform();
  diagLog(`flip correction ${next ? 'ON' : 'off'} (gravity y ${y.toFixed(1)})`);
}

function applyPreviewTransform() {
  video.style.transform = [facing === 'user' && 'scaleX(-1)', frameTurn && 'rotate(180deg)'].filter(Boolean).join(' ');
}

window.addEventListener('devicemotion', (e) => {
  const g = e.accelerationIncludingGravity;
  if (g && g.x !== null && g.y !== null) updateFrameTurn(g.x, g.y);
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
// browser sets up its rotation again. Turns are caught three ways, because a browser may not
// report a 180° turn through every one of them: screen.orientation 'change', the older
// window 'orientationchange', and polling the angle every 500 ms while running.
const screenAngle = () => {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
};
let lastAngle = screenAngle();
function checkScreenTurn(source) {
  const angle = screenAngle();
  if (angle === lastAngle) return;
  const turnedOver = Math.abs(angle - lastAngle) === 180;
  diagLog(`screen ${lastAngle}°→${angle}° (${source})${turnedOver && running ? ': reopening camera' : ''}`);
  lastAngle = angle;
  if (!turnedOver || !running) return;
  diag.reopens++;
  resetView(); // the old frames were upside down; describe the view afresh
  reopenCamera();
}
screen.orientation?.addEventListener('change', () => checkScreenTurn('change event'));
window.addEventListener('orientationchange', () => checkScreenTurn('orientationchange'));
setInterval(() => { if (running) checkScreenTurn('poll'); }, 500);
document.addEventListener('fullscreenchange', () => diagLog(`fullscreen ${document.fullscreenElement ? 'on' : 'off'}`));

// ---------- diagnostics: the 🐞 button (or ?debug) ----------
// Shows what the browser reports, to diagnose camera orientation problems on a device.
// VERSION is a fixed label for this code, so a tester can confirm the phone has it loaded.
const VERSION = 'flip-fix-1';
// (localStorage read inline: loadPref is defined later in this file.)
let debugMode = new URLSearchParams(location.search).has('debug') || (() => { try { return localStorage.getItem('debug') === '1'; } catch { return false; } })();
const diag = { lock: 'not tried yet', reopens: 0, gravity: '-', holding: '-', frame: '', events: [] };
function setLockState(state) { diag.lock = state; diagLog(`lock: ${state}`); }
function diagLog(msg) {
  diag.events.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
  diag.events.length = Math.min(diag.events.length, 8);
  renderDiag();
}
function renderDiag() {
  if (!debugMode) return;
  const s = stream?.getVideoTracks()[0]?.getSettings() || {};
  $('debugText').textContent = [
    `version ${VERSION} · touch device ${isPhone}`,
    `screen ${screen.orientation?.type ?? '-'} ${screenAngle()}° · window.orientation ${window.orientation ?? '-'}`,
    `fullscreen ${document.fullscreenElement ? 'on' : 'off'} · lock ${diag.lock}`,
    `camera frame rotation ${diag.frame || '-'}`,
    `flip correction ${FLIP_CORRECTION ? (frameTurn ? 'ON (turning image 180°)' : 'off (image upright)') : 'disabled (not Android)'}`,
    `video ${video.videoWidth}×${video.videoHeight} · track ${s.width ?? '-'}×${s.height ?? '-'} ${s.facingMode ?? ''}`,
    `phone held: ${diag.holding} (gravity x,y,z ${diag.gravity}) · camera reopens ${diag.reopens}`,
    ...diag.events,
  ].join('\n');
}

// How the phone is held, from gravity: the axis carrying most of it.
function describeHolding(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (az >= ax && az >= ay) return z > 0 ? 'flat, screen up' : 'flat, screen down';
  if (ay >= ax) return y > 0 ? 'upright' : 'upside down';
  return x > 0 ? 'on its side (x+)' : 'on its side (x-)';
}
window.addEventListener('devicemotion', (e) => {
  if (!debugMode) return;
  const g = e.accelerationIncludingGravity;
  if (!g || g.x === null) return;
  diag.gravity = [g.x, g.y, g.z].map((v) => (v ?? 0).toFixed(1)).join(', ');
  const holding = describeHolding(g.x, g.y, g.z);
  if (holding !== diag.holding) { if (diag.holding !== '-') diagLog(`phone now ${holding}`); diag.holding = holding; }
});

// Picture-based check of the flip correction: compares each raw camera frame (before the app's
// correction) with the previous one. A sudden half-turn by the browser shows up as the previous
// frame matching much better once rotated 180°. Logged with the gravity reading at that moment,
// so the real tipping point can be compared with FLIP_ON_Y / FLIP_OFF_Y.
const rawCanvas = document.createElement('canvas');
const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
let lastRaw = null;
function detectBrowserFlip() {
  rawCanvas.width = THUMB_W;
  rawCanvas.height = THUMB_H;
  rawCtx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
  const px = rawCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const raw = new Float32Array(THUMB_W * THUMB_H);
  for (let i = 0; i < raw.length; i++) raw[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  if (lastRaw) {
    const same = Filter.viewChange(lastRaw, raw);
    const turned = Filter.viewChange(lastRaw.slice().reverse(), raw); // reversed pixels = 180° turn
    if (turned < 0.3 && same > turned + 0.4) {
      diagLog(`browser turned image 180° (seen in picture) · gravity ${diag.gravity} · correction ${frameTurn ? 'ON' : 'off'}`);
    }
  }
  lastRaw = raw;
}

// The camera's own rotation tag on each frame (WebCodecs VideoFrame.rotation / .flip), read
// from a copy of the camera track. If it changes while the screen angle doesn't, the browser
// is turning the image itself, independent of the screen lock.
let frameWatch = null;
function watchFrames() {
  stopFrameWatch();
  const track = stream?.getVideoTracks()[0];
  if (!debugMode || !track) return;
  if (typeof MediaStreamTrackProcessor === 'undefined') { diag.frame = 'not readable in this browser'; return; }
  const copy = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: copy }).readable.getReader();
  const watch = { alive: true };
  watch.stop = () => { watch.alive = false; reader.cancel().catch(() => {}); copy.stop(); };
  frameWatch = watch;
  let lastRead = 0, lastTag = '';
  (async () => {
    while (watch.alive) {
      const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (performance.now() - lastRead > 250) {
        lastRead = performance.now();
        const tag = `${frame.rotation ?? 'n/a'}°, flip ${frame.flip ?? 'n/a'}`;
        if (lastTag && tag !== lastTag) diagLog(`camera frame rotation ${lastTag} → ${tag}`);
        lastTag = tag;
        diag.frame = `${tag} · coded ${frame.codedWidth}×${frame.codedHeight} · shown ${frame.displayWidth}×${frame.displayHeight}`;
      }
      frame.close();
    }
  })();
}
function stopFrameWatch() {
  if (frameWatch) frameWatch.stop();
  frameWatch = null;
}

function setDebug(on) {
  debugMode = on;
  savePref('debug', on);
  $('debug').hidden = !on;
  $('debugBtn').setAttribute('aria-pressed', String(on));
  if (on) { watchFrames(); renderDiag(); } else stopFrameWatch();
}
$('debugBtn').addEventListener('click', () => setDebug(!debugMode));
$('debug').hidden = !debugMode;
$('debugBtn').setAttribute('aria-pressed', String(debugMode));
setInterval(renderDiag, 500);

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
  applyPreviewTransform();
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
