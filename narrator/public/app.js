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
const askBtn = $('ask');
const currentEl = $('current');
const historyEl = $('history');
const startBtn = $('start');
const intervalInput = $('interval');
const intervalOut = $('intervalOut');

const MAX_SIDE = 768; // at 512 the model misread room numbers ("71A" as "714"); same latency
const JPEG_QUALITY = 0.7;
const HISTORY_LEN = 4;
const REQUEST_TIMEOUT_MS = 20000;
const REASONING_TIMEOUT_MS = 30000; // with Low/High reasoning a frame can take several seconds
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
function checkViewChange(thumb) {
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

// ---------- blur gate ----------
// Blurry frames (motion while walking or swinging the phone, out of focus) aren't sent: tested
// on blurred photos, Perceptron lost room numbers, halved a stair count and invented "cars
// approaching". Sharpness (Filter.sharpness, edge strength on a 160x120 copy) is judged against
// recent frames *of the same view*, since a sharp blank wall also scores low. Calibrated on 29
// photos: at 0.5x, 25/29 with 5 px motion blur and 29/29 defocused were caught, and no camera
// shake or brightness change was wrongly skipped.
const BLUR_RATIO = 0.5;          // blurry when below this x the 90th percentile of recent scores
const BLUR_WINDOW_MS = 8000;     // recent = scores from the same view in the last 8 s
const BLUR_MIN_HISTORY = 4;      // with fewer scores than this, every frame counts as sharp
const MAX_TURN_RATE = 90;        // deg/s from the gyroscope: faster = motion blur, whatever the score
const BLUR_FALLBACK_MS = 2000;   // nothing sharp for this long: send the sharpest frame seen
const BLUR_RETRY_MS = 100;       // after a blurry frame, look again this soon
const HINT_AFTER_MS = 3000;      // blurry this long: speak the hint
const HINT_COOLDOWN_MS = 15000;
const HINT_TEXT = 'Hold the phone steady.';
const SHARP_W = 160, SHARP_H = 120;
const SKIPPED = 'skipped';

const sharpCanvas = document.createElement('canvas');
const sharpCtx = sharpCanvas.getContext('2d', { willReadFrequently: true });
let blurScores = [];   // { t, score } for the current blur reference view
let blurView = null;   // thumbnail the blur reference belongs to
let windowStart = 0;   // start of the current wait for a sharp frame
let blurSince = null;  // when the current run of blurry frames began (null: last frame sharp)
let bestBlurry = null; // sharpest skipped frame of the current window: { image, thumb, score }
let lastHint = -Infinity;
let turnRate = 0;      // deg/s, latest gyroscope reading
const blurStats = { verdict: '-', score: 0, threshold: 0, skipped: 0 };

window.addEventListener('devicemotion', (e) => {
  const r = e.rotationRate;
  if (r && r.alpha !== null) turnRate = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
});

function frameSharpness() {
  sharpCanvas.width = SHARP_W;
  sharpCanvas.height = SHARP_H;
  sharpCtx.drawImage(canvas, 0, 0, SHARP_W, SHARP_H); // canvas holds the frame just grabbed
  const px = sharpCtx.getImageData(0, 0, SHARP_W, SHARP_H).data;
  const gray = new Float32Array(SHARP_W * SHARP_H);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return Filter.sharpness(gray, SHARP_W, SHARP_H);
}

// 'sharp' | 'blurry' | 'motion' for a frame with this thumbnail and sharpness score.
function judgeBlur(thumb, score, now) {
  if (!blurView || Filter.viewChange(blurView, thumb) > VIEW_CHANGE) { blurView = thumb; blurScores = []; } // new scene: new reference
  blurScores = blurScores.filter((s) => now - s.t <= BLUR_WINDOW_MS);
  const sorted = blurScores.map((s) => s.score).sort((a, b) => a - b);
  const reference = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0;
  const enough = sorted.length >= BLUR_MIN_HISTORY;
  blurScores.push({ t: now, score });
  blurStats.score = score;
  blurStats.threshold = enough ? reference * BLUR_RATIO : 0;
  if (turnRate > MAX_TURN_RATE) return 'motion';
  return enough && score < reference * BLUR_RATIO ? 'blurry' : 'sharp';
}

function maybeHint(now) {
  if (blurSince === null || now - blurSince < HINT_AFTER_MS || now - lastHint < HINT_COOLDOWN_MS) return;
  lastHint = now;
  if (Speech.enabled) { // spoken only: not a scene alert, not added to `said`
    Speech.say(HINT_TEXT);
    logReply({ kind: 'hint', text: HINT_TEXT });
  }
}

function resetBlur() {
  blurScores = []; blurView = null; windowStart = 0; blurSince = null; bestBlurry = null;
}

// Grab a frame and decide whether to send it: { image, thumb } to send, SKIPPED (blurry, look
// again soon) or null (no camera frame yet).
function pickFrame() {
  const image = grabFrame();
  if (!image) return null; // camera starting or switching
  const thumb = grabThumb();
  const now = performance.now();
  if (!windowStart) windowStart = now;
  const score = frameSharpness();
  const verdict = judgeBlur(thumb, score, now);
  if (verdict === 'sharp') {
    blurSince = null;
    blurStats.verdict = 'sharp';
    if (statusEl.textContent.includes('hold steady')) setStatus('Live', true);
  } else {
    blurStats.skipped++;
    if (blurSince === null) blurSince = now;
    if (!bestBlurry || score > bestBlurry.score) bestBlurry = { image, thumb, score };
    maybeHint(now);
    if (now - windowStart < BLUR_FALLBACK_MS) {
      blurStats.verdict = verdict === 'motion' ? `skipped: phone moving ${Math.round(turnRate)}°/s` : 'skipped: blurry';
      if (!speaking()) setStatus('Live · hold steady (blurry)', true);
      return SKIPPED;
    }
    blurStats.verdict = 'sent sharpest of the last 2 s (all blurry)';
  }
  const frame = verdict === 'sharp' ? { image, thumb } : bestBlurry;
  windowStart = now;
  bestBlurry = null;
  return frame;
}

async function sendFrame(id, frame) {
  const { image, thumb } = frame;
  if (debugMode) $('debugFrame').src = image; // exactly what Perceptron is sent
  checkViewChange(thumb);
  const t0 = performance.now();
  const seq = ++sentSeq;
  const view = viewId;
  const size = `${canvas.width}x${canvas.height}`;

  // 'none' | 'low' | 'high' (see prompt.js), or 'hybrid' ("Fast + Low"): this request without
  // reasoning, plus a parallel Low-reasoning request for the same frame (sendSlow).
  const hybrid = reasoningSelect.value === 'hybrid';
  const reasoning = hybrid ? 'none' : reasoningSelect.value;
  const sensor = sensorContext(); // taken once, so the fast and slow requests for a frame agree
  const body = { image, said, reasoning, style: alertStyle(), sensor };
  if (hybrid && slowInFlight.size < MAX_SLOW_IN_FLIGHT) sendSlow(id, seq, view, { image, said, sensor }, t0);
  // Perceptron rejects clips whose frames differ in size (e.g. after the phone rotates).
  if (MOTION_FRAMES && prevFrame && prevFrame.size === size && t0 - prevFrame.t <= MAX_PREV_FRAME_AGE) {
    body.prevImage = prevFrame.image;
    body.prevDtMs = Math.round(t0 - prevFrame.t);
  }
  if (MOTION_FRAMES) prevFrame = { image, size, t: t0 };

  const controller = new AbortController();
  inFlight.add(controller);
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), reasoning === 'none' ? REQUEST_TIMEOUT_MS : REASONING_TIMEOUT_MS);
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
    logReply({ kind: 'error', text: e.message || String(e) });
    setStatus('Error', false);
    currentEl.textContent = e.message || String(e);
    currentEl.classList.add('error');
  } finally {
    clearTimeout(timer);
    inFlight.delete(controller);
  }
}

// Every reply and what was done with it goes to the History log (log.js), including those the
// filter dropped. `typeof` check: the app still runs if log.js failed to load.
function logReply(entry) { if (typeof Log !== 'undefined') Log.add(entry); }

function handleReply(seq, view, reply, totalMs, apiMs) {
  if (seq < shownSeq || view !== viewId) { // a newer frame was answered, or the view changed
    logReply({ kind: 'late', text: reply, ms: totalMs });
    return;
  }
  shownSeq = seq;
  latencyEl.textContent = Number.isFinite(apiMs)
    ? `${Math.round(totalMs)} ms (model ${Math.round(apiMs)})`
    : `${Math.round(totalMs)} ms`;
  const wasError = currentEl.classList.contains('error');
  currentEl.classList.remove('error');

  // Filter (filter.js) drops "n/a" and restatements of what was already shown for this view.
  // It checks the current `said`, which may be newer than the one this request was sent with.
  const { text, reason } = Filter.classifyReply(reply, said);
  logReply(text ? { kind: 'alert', text, ms: totalMs } : { kind: reason, text: reply, ms: totalMs });
  if (!text) {
    // Say why nothing changed: the model saw nothing new, or it repeated an earlier alert.
    setStatus(reason === 'repeat' ? 'Live · already said' : 'Live · nothing new', true);
    if (!currentEl.dataset.alert) currentEl.textContent = 'Nothing important in view.';
    else if (wasError) currentEl.textContent = currentEl.dataset.alert;
    return;
  }
  setStatus('Live', true);
  showAlert(text);
}

// Show and speak a new alert; the previous one moves to history.
function showAlert(text) {
  const shown = currentEl.dataset.alert;
  if (shown) pushHistory(shown);
  currentEl.textContent = text;
  currentEl.dataset.alert = text;
  said = [...said, text].slice(-MAX_SAID);
  // Hazard alerts ("Trip hazard: …", "Drop-off: …") cut in ahead of non-hazard speech.
  Speech.say(text, { urgent: Filter.hazardLabel(text) !== null });
}

// ---------- spoken questions (🎤 Ask) ----------
// Tap the Ask button once and speak: the question is sent when you stop talking (about 1.2 s of
// silence; see recorder.js). Tapping again sends at once. Holding works too: while the button is
// held, pauses don't send and releasing does. If no speech is heard within 6 s, the ask ends
// with nothing sent. Screen readers' double-tap and Enter act as taps. The current frame and the WAV go to
// POST /api/ask; the answer is shown and spoken first (urgent). While asking, narration pauses,
// speech stops and beeps are muted so the mic doesn't hear them.
const HOLD_MS = 400; // pressed longer than this = hold-to-talk; shorter = tap-to-toggle
let asking = false;  // from the start of recording until the answer is shown
let pressAt = 0;

function cue(freq) { // short tone so a blind user knows the mic opened / closed
  const ac = Speech.context;
  if (!ac) return;
  const osc = ac.createOscillator(), env = ac.createGain();
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, ac.currentTime);
  env.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.12);
  osc.connect(env); env.connect(ac.destination);
  osc.start(); osc.stop(ac.currentTime + 0.13);
  if (navigator.vibrate) navigator.vibrate(30);
}

async function startAsk() {
  if (asking) return;
  if (!running) { setStatus('Tap Start first, then ask', false); return; }
  Speech.unlock();
  asking = true;
  Speech.cancel();
  Beeper.enabled = false;
  askBtn.classList.add('listening');
  askBtn.setAttribute('aria-pressed', 'true');
  // Tone before the mic opens: once it is open, Android turns playback down and the tone is
  // inaudible (on the phone only the vibration was noticed).
  cue(880);
  try {
    await Recorder.start(Speech.context, {
      onLimit: () => finishRecording(),
      onSilence: () => { if (!pressStarted) finishRecording(); }, // held: releasing sends instead
      onNoSpeech: () => { if (!pressStarted) noQuestion(); },
    });
  } catch (e) {
    endAsk();
    setStatus('Microphone unavailable', false);
    currentEl.textContent = `Microphone error: ${e.message}`;
    return;
  }
  setStatus('Listening… ask your question', true);
}

function noQuestion() {
  if (!asking || !Recorder.recording) return;
  cue(440);
  endAsk();
  setStatus("Didn't hear a question", true);
}

async function finishRecording() {
  if (!asking || !Recorder.recording) return;
  const rec = Recorder.stop();
  cue(660);
  askBtn.classList.remove('listening');
  askBtn.setAttribute('aria-pressed', 'false');
  if (!rec) { endAsk(); setStatus('Too short: tap Ask, then speak', true); return; }
  const image = grabFrame();
  if (!image) { endAsk(); setStatus('Camera not ready', false); return; }
  setStatus('Thinking…', true);
  const t0 = performance.now();
  try {
    const level = reasoningSelect.value === 'hybrid' ? 'none' : reasoningSelect.value;
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, audio: rec.audio, reasoning: level, sensor: sensorContext() }),
    });
    // The server doesn't know /api/ask: it is still running code from before this feature.
    if (res.status === 404 || res.status === 405) throw new Error('Server is out of date: restart node server.js');
    if (!res.ok) throw new Error(await res.text());
    // Same cautious stair count as alerts (×0.75, rounded down): the model overcounts.
    const answer = Filter.fixStairLabel(Filter.cautiousStairCount((await res.text()).replace(/\s+/g, ' ').trim()));
    latencyEl.textContent = `answer ${Math.round(performance.now() - t0)} ms`;
    if (answer) { logReply({ kind: 'answer', text: answer, ms: performance.now() - t0 }); showAnswer(answer); }
    setStatus('Live', true);
  } catch (e) {
    logReply({ kind: 'error', text: `Question: ${e.message || e}` });
    setStatus('Could not answer', false);
    currentEl.textContent = e.message || String(e);
  } finally {
    endAsk();
  }
}

// An answer is always shown and spoken (never repeat-filtered), ahead of other speech, and is not
// added to `said`, so the narration's repeat filtering isn't affected.
function showAnswer(text) {
  const shown = currentEl.dataset.alert;
  if (shown) pushHistory(shown);
  currentEl.textContent = text;
  currentEl.dataset.alert = text; // tap the card to hear it again
  Speech.say(text, { urgent: true });
}

function endAsk() {
  if (Recorder.recording) Recorder.cancel();
  asking = false;
  askBtn.classList.remove('listening');
  askBtn.setAttribute('aria-pressed', 'false');
  Beeper.enabled = beepsBox.checked;
}

// Press handling (on top of the automatic send when the user stops talking):
//   press ... release after >= HOLD_MS  -> send (hold-to-talk)
//   quick tap                            -> keeps recording; sent on silence or the next tap
//   click with no press just before it   -> toggle (keyboard, some screen readers)
let pressStarted = false;  // this press opened the mic (true while it is held)
let pressStops = false;    // this press is the second tap of toggle mode
let lastPointerAt = 0;
askBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  lastPointerAt = pressAt = performance.now();
  pressStarted = pressStops = false;
  if (!asking) { pressStarted = true; startAsk(); }
  else if (Recorder.recording) pressStops = true;
});
askBtn.addEventListener('pointerup', () => {
  lastPointerAt = performance.now();
  if (pressStops) { pressStops = false; finishRecording(); return; }
  if (pressStarted && performance.now() - pressAt >= HOLD_MS) finishRecording(); // held: send
  pressStarted = false;
});
askBtn.addEventListener('pointercancel', () => { pressStarted = pressStops = false; if (asking && Recorder.recording) finishRecording(); });
askBtn.addEventListener('click', () => {
  if (performance.now() - lastPointerAt < 800) return; // already handled by the pointer events
  if (asking && Recorder.recording) finishRecording();
  else if (!asking) startAsk();
});

// ---------- "Fast + Low" (hybrid) reasoning ----------
// The Low-reasoning reply for a frame arrives ~1 s after the fast one and only adds or corrects
// (e.g. "arrow right" where the fast reply said "arrow left"). It has its own ordering: newer
// fast replies always arrive first, so the fast `shownSeq` check would discard every one.
const MAX_SLOW_IN_FLIGHT = 2;   // keeps fast + slow under Perceptron's 300 requests/min
const SLOW_MAX_AGE_MS = 4000;   // a refinement older than this describes a moment long gone
const slowInFlight = new Set();
let shownSlowSeq = 0;
const slowStats = { ms: 0, spoken: 0, suppressed: 0, stale: 0 };

async function sendSlow(id, seq, view, { image, said: saidThen, sensor }, t0) {
  const controller = new AbortController();
  slowInFlight.add(controller);
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REASONING_TIMEOUT_MS);
  try {
    const res = await fetch('/api/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, said: saidThen, reasoning: 'low', style: alertStyle(), sensor }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 429) pausedUntil = performance.now() + Math.max(2000, Number(res.headers.get('retry-after')) * 1000 || 0);
      return;
    }
    const reply = await res.text();
    if (id !== runId) return;
    handleSlowReply(seq, view, reply, t0);
  } catch {
    /* refinements are optional: the fast path already reported this frame */
  } finally {
    clearTimeout(timer);
    slowInFlight.delete(controller);
  }
}

function handleSlowReply(seq, view, reply, t0) {
  const age = performance.now() - t0;
  slowStats.ms = Math.round(age);
  if (view !== viewId || age > SLOW_MAX_AGE_MS || seq < shownSlowSeq) {
    slowStats.stale++;
    logReply({ kind: 'late', text: reply, ms: age, mode: 'low' });
    return;
  }
  shownSlowSeq = seq;
  const { text, reason } = Filter.classifyReply(reply, said, { refine: true });
  logReply(text ? { kind: 'correction', text, ms: age, mode: 'low' } : { kind: reason, text: reply, ms: age, mode: 'low' });
  if (!text) { slowStats.suppressed++; return; }
  slowStats.spoken++;
  showAlert(text);
}

function pushHistory(text) {
  const li = document.createElement('li');
  li.textContent = text;
  historyEl.prepend(li);
  while (historyEl.children.length > HISTORY_LEN) historyEl.lastChild.remove();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Pause while speaking" toggle (default on): while an alert is being spoken (or waiting to be),
// no new frames are sent, so the user hears each alert in full before the app looks again.
// Requests already in flight still finish. Trade-off: nothing new is detected during speech
// (typically 2-3 s per alert); turn it off to keep looking while the voice talks.
let pauseWhileSpeaking = true;
const speaking = () => pauseWhileSpeaking && Speech.enabled && Speech.pending > 0;

async function loop(id) {
  while (running && id === runId) {
    if (asking) { await sleep(100); continue; } // a spoken question is being recorded or answered
    if (speaking()) {
      if (!statusEl.textContent.includes('speaking')) setStatus('Live · paused while speaking', true);
    } else if (inFlight.size < MAX_IN_FLIGHT && performance.now() >= pausedUntil) {
      const frame = pickFrame();
      if (frame === SKIPPED) { await sleep(BLUR_RETRY_MS); continue; } // blurry: look again soon
      if (frame) sendFrame(id, frame);
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
    ...(reasoningSelect.value === 'hybrid' ? [`fast + low: last low reply ${slowStats.ms} ms · spoken ${slowStats.spoken} · suppressed ${slowStats.suppressed} · too late ${slowStats.stale} · in flight ${slowInFlight.size}`] : []),
    `sensor→AI: ${sensorDiag()}`,
    `blur: ${blurStats.verdict} · sharpness ${blurStats.score.toFixed(1)} (blurry below ${blurStats.threshold ? blurStats.threshold.toFixed(1) : '-'}) · skipped ${blurStats.skipped} · turning ${Math.round(turnRate)}°/s`,
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
  Beeper.start(); // distance-sensor beeps (shares the audio context unlocked above)
  loop(id);
}

// Treat whatever the camera sees next as a fresh view.
function resetView() {
  viewId++;
  viewThumb = null;
  said = [];
  prevFrame = null;
  resetBlur();
}

function stop() {
  running = false;
  runId++;
  if (asking) endAsk(); // also releases the microphone
  resetView();
  for (const c of inFlight) c.abort();
  inFlight.clear();
  for (const c of slowInFlight) c.abort();
  slowInFlight.clear();
  Speech.cancel();
  Beeper.stop();
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

// Alert style: Safety labels on (default, "Trip hazard: curb close ahead.") or off (the earlier,
// "classic" prompt: "Curb close ahead."). Chooses the system prompt in prompt.js. Saved.
const safetyBox = $('safetyLabels');
safetyBox.checked = loadPref('safetyLabels', true);
safetyBox.addEventListener('change', () => savePref('safetyLabels', safetyBox.checked));
function alertStyle() { return safetyBox.checked ? 'safety' : 'classic'; }

// Perceptron reasoning: Off (fast, default) / Low / High. Saved on the device.
const reasoningSelect = $('reasoning');
try {
  const saved = localStorage.getItem('reasoning');
  if (['none', 'low', 'high', 'hybrid'].includes(saved)) reasoningSelect.value = saved;
} catch { /* storage blocked */ }
reasoningSelect.addEventListener('change', () => {
  try { localStorage.setItem('reasoning', reasoningSelect.value); } catch { /* storage blocked */ }
});

const pauseBox = $('pauseSpeaking');
pauseBox.checked = loadPref('pauseWhileSpeaking', true);
pauseWhileSpeaking = pauseBox.checked;
pauseBox.addEventListener('change', () => {
  pauseWhileSpeaking = pauseBox.checked;
  savePref('pauseWhileSpeaking', pauseBox.checked);
  if (!pauseWhileSpeaking && statusEl.textContent.includes('paused while speaking')) setStatus('Live', running);
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

// ---------- proximity beeps (ESP8266 distance sensor, see beeper.js) ----------

const beepsBox = $('beeps');
const beepVolumeInput = $('beepVolume');
const beepIntensityInput = $('beepIntensity');
const loadNumber = (key, fallback) => { try { const v = Number(localStorage.getItem(key)); return localStorage.getItem(key) === null || !Number.isFinite(v) ? fallback : v; } catch { return fallback; } };
const saveNumber = (key, v) => { try { localStorage.setItem(key, String(v)); } catch { /* storage blocked */ } };

beepsBox.checked = loadPref('beeps', true);
beepVolumeInput.value = loadNumber('beepVolume', 60);
beepIntensityInput.value = loadNumber('beepIntensity', 1);

function applyBeepSettings() {
  Beeper.enabled = beepsBox.checked;
  Beeper.volume = Number(beepVolumeInput.value) / 100;
  Beeper.intensity = Number(beepIntensityInput.value);
  $('beepVolumeOut').textContent = `${beepVolumeInput.value}%`;
  $('beepIntensityOut').textContent = `${Number(beepIntensityInput.value).toFixed(1)}×`;
}
beepsBox.addEventListener('change', () => { Speech.unlock(); savePref('beeps', beepsBox.checked); applyBeepSettings(); });
beepVolumeInput.addEventListener('input', () => { saveNumber('beepVolume', beepVolumeInput.value); applyBeepSettings(); });
beepIntensityInput.addEventListener('input', () => { saveNumber('beepIntensity', beepIntensityInput.value); applyBeepSettings(); });
applyBeepSettings();

// ---------- distance reading in the AI requests ----------
// With "Share distance with AI" on, each request carries the sensor's latest valid reading and its
// mounting height (prompt.js turns them into one paragraph; alerts never say the number). Nothing
// is sent when the sensor is offline, out of range or stale (Beeper.reading is null).
// Elements are read directly rather than through consts: renderDiag can run before this point.
function sensorContext() {
  const box = $('sensorToAi'), r = Beeper.reading;
  if (!box || !box.checked || !r) return undefined;
  return { distanceM: Math.round(r.metres * 100) / 100, heightM: Math.round(Number($('sensorHeight').value) * 100) / 100 };
}
function sensorDiag() {
  if (!$('sensorToAi').checked) return 'off';
  const s = sensorContext();
  return s ? `${s.distanceM.toFixed(2)} m @ ${s.heightM.toFixed(2)} m high` : `not sent (sensor ${Beeper.state})`;
}
const sensorBox = $('sensorToAi');
const sensorHeightInput = $('sensorHeight');
sensorBox.checked = loadPref('sensorToAi', true);
sensorHeightInput.value = loadNumber('sensorHeight', 1);
const showSensorHeight = () => { $('sensorHeightOut').textContent = `${Number(sensorHeightInput.value).toFixed(2)} m`; };
sensorBox.addEventListener('change', () => savePref('sensorToAi', sensorBox.checked));
sensorHeightInput.addEventListener('input', () => { saveNumber('sensorHeight', sensorHeightInput.value); showSensorHeight(); });
showSensorHeight();

// Header chip: what the sensor reports ('off' before Start).
Beeper.onChange = (state) => {
  $('distance').textContent = state === 'off' ? ''
    : state === 'offline' ? 'sensor offline'
    : state === 'clear' ? 'sensor: clear'
    : `obstacle ${state} m`;
};

const showInterval = () => { intervalOut.textContent = `${(Number(intervalInput.value) / 1000).toFixed(1)}s`; };
intervalInput.addEventListener('input', showInterval);
showInterval();

// Pause while the page is hidden; resume when it comes back.
let resumeOnShow = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) { resumeOnShow = true; stop(); }
  else if (!document.hidden && resumeOnShow) { resumeOnShow = false; start(); }
});
