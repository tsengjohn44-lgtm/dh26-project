// Capture loop: grab a frame, stream its description from /api/describe, repeat.
// Only one request is in flight at a time so requests never pile up.

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const statusEl = $('status');
const latencyEl = $('latency');
const currentEl = $('current');
const historyEl = $('history');
const startBtn = $('start');
const gapInput = $('gap');
const gapOut = $('gapOut');

const MAX_SIDE = 512;
const JPEG_QUALITY = 0.7;
const HISTORY_LEN = 4;
const REQUEST_TIMEOUT_MS = 20000;
const NO_CHANGE = 'no change.';

let stream = null;
let facing = 'environment';
let running = false;
let runId = 0; // bumps on every start/stop so a stale loop exits instead of running twice
let controller = null;
let previous = '';
let wakeLock = null;

// ---------- camera ----------

async function openCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
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

// ---------- describe loop ----------

class HttpError extends Error {
  constructor(message, retryAfterMs) { super(message); this.retryAfterMs = retryAfterMs; }
}

const isNoChange = (text) => text.trim().toLowerCase().replace(/\.$/, '') === 'no change';
// True while a partial reply could still turn out to be "No change." (don't flash it on screen).
const mayBeNoChange = (text) => NO_CHANGE.startsWith(text.trim().toLowerCase());

async function describeOnce() {
  const image = grabFrame();
  if (!image) return false;

  controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch('/api/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, previous }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new HttpError(await res.text(), retryAfter > 0 ? retryAfter * 1000 : 0);
    }

    // Stream tokens into the caption as they arrive.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text && !mayBeNoChange(text)) currentEl.textContent = text;
    }
    text = text.trim();
    latencyEl.textContent = `${Math.round(performance.now() - t0)} ms`;
    if (!text) return true;

    if (isNoChange(text)) {
      setStatus('Live · no change', true);
      if (previous) currentEl.textContent = previous;
      return true;
    }
    setStatus('Live', true);
    currentEl.textContent = text;
    if (previous && previous !== text) pushHistory(previous);
    previous = text;
    return true;
  } finally {
    clearTimeout(timer);
  }
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
    const started = performance.now();
    try {
      // No frame yet (camera starting or switching): wait instead of spinning.
      if (!(await describeOnce())) { await sleep(100); continue; }
    } catch (e) {
      if (!running || id !== runId) break;
      setStatus('Error', false);
      currentEl.textContent = e.message || String(e);
      currentEl.classList.add('error');
      await sleep(Math.max(2000, e.retryAfterMs || 0));
      currentEl.classList.remove('error');
      continue;
    }
    const wait = Number(gapInput.value) - (performance.now() - started);
    if (wait > 0) await sleep(wait);
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
  startBtn.textContent = 'Stop';
  startBtn.classList.add('running');
  setStatus('Starting…', true);
  currentEl.textContent = 'Looking…';
  requestWakeLock();
  loop(id);
}

function stop() {
  running = false;
  runId++;
  controller?.abort();
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
  if (stream) {
    try { await openCamera(); } catch (e) { currentEl.textContent = `Camera error: ${e.message}`; }
  }
});

gapInput.addEventListener('input', () => {
  gapOut.textContent = `${(Number(gapInput.value) / 1000).toFixed(gapInput.value % 1000 ? 2 : 0)}s`;
});

// Pause while the page is hidden; resume when it comes back.
let resumeOnShow = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) { resumeOnShow = true; stop(); }
  else if (!document.hidden && resumeOnShow) { resumeOnShow = false; start(); }
});
