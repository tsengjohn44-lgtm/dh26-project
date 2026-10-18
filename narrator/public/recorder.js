// Records a spoken question from the microphone as a 16 kHz mono 16-bit WAV (base64), the format
// Perceptron's `input_audio` accepts. MediaRecorder can't be used: it produces webm/opus (Chrome)
// or mp4/aac (Safari). Instead raw samples are read through the shared Web Audio context and
// encoded here. Runs in the browser (window.Recorder); the pure helpers also load in Node for tests.
(function (root) {
  const TARGET_RATE = 16000;
  const MAX_SECONDS = 15;   // longer questions are cut off (auto-stop)
  const MIN_SECONDS = 0.4;  // shorter = an accidental tap: nothing is sent

  // End-of-speech detection, so a question is sent when the user stops talking (no second tap).
  const CALIBRATE_MS = 250;  // the noise floor is the quietest level in the first 250 ms
  const MIN_LEVEL = 0.015;   // RMS; speech must be at least this loud...
  const FLOOR_FACTOR = 3;    // ...and 3x the background noise
  const END_FACTOR = 0.7;    // speech ends below 0.7x that (hysteresis: a fading word isn't silence)
  const SPEECH_MS = 200;     // this much time above the threshold = speech (clicks and bumps aren't)
  const GAP_RESET_MS = 300;  // a quiet gap this long before speech is confirmed resets that count
  const SILENCE_MS = 1200;   // this long quiet after speech = the question is finished
  const NO_SPEECH_MS = 6000; // no speech at all by then = give up
  const TRAIL_MS = 300;      // audio kept after the last speech; the rest of the silence is trimmed

  // Pure (testable in Node). push(chunk) returns 'speech-start', 'silence', 'no-speech' or null;
  // after 'silence' or 'no-speech' it is done and returns null. lastSpeechMs = the end of speech.
  function createSpeechDetector(rate) {
    let t = 0, floor = Infinity, aboveMs = 0, gapMs = 0, quietMs = 0, heard = false, done = false, lastSpeechMs = 0;
    function push(samples) {
      if (done || !samples.length) return null;
      const ms = samples.length / rate * 1000;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const level = Math.sqrt(sum / samples.length);
      t += ms;
      if (t <= CALIBRATE_MS) { floor = Math.min(floor, level); return null; }
      if (!Number.isFinite(floor)) floor = level;
      const threshold = Math.max(MIN_LEVEL, floor * FLOOR_FACTOR);
      if (!heard) {
        if (level > threshold) { aboveMs += ms; gapMs = 0; }
        else {
          gapMs += ms;
          if (gapMs >= GAP_RESET_MS) aboveMs = 0;
          floor += (level - floor) * Math.min(1, ms / 2000); // follow slow changes in background noise
        }
        if (aboveMs >= SPEECH_MS) { heard = true; lastSpeechMs = t; return 'speech-start'; }
        if (t >= NO_SPEECH_MS) { done = true; return 'no-speech'; }
        return null;
      }
      if (level > threshold * END_FACTOR) { quietMs = 0; lastSpeechMs = t; return null; }
      quietMs += ms;
      if (quietMs >= SILENCE_MS) { done = true; return 'silence'; }
      return null;
    }
    return { push, get heard() { return heard; }, get lastSpeechMs() { return lastSpeechMs; } };
  }

  // Average-based decimation: each output sample is the mean of the input samples it covers.
  function downsample(samples, fromRate, toRate = TARGET_RATE) {
    if (fromRate === toRate) return Float32Array.from(samples);
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * ratio), end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  // Float samples (-1..1) -> WAV bytes (RIFF header + 16-bit little-endian PCM, mono).
  function encodeWav(samples, rate = TARGET_RATE) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return bytes;
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  // ---------- live recording (browser only) ----------
  const WORKLET = `class NarratorCapture extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
  }
  registerProcessor('narrator-capture', NarratorCapture);`;
  let workletLoaded = null;
  let stream = null, source = null, node = null, sink = null, timer = null;
  let chunks = [], rate = 48000, recording = false, detector = null;

  // Starts recording through `ctx` (the AudioContext unlocked by the Start tap). Throws if the
  // microphone is unavailable or permission is denied. Callbacks (each fires at most once):
  // onLimit at MAX_SECONDS, onSilence when the user stops talking, onNoSpeech if they never start.
  // A bare function means onLimit.
  async function start(ctx, opts) {
    if (recording) return;
    const { onLimit, onSilence, onNoSpeech } = typeof opts === 'function' ? { onLimit: opts } : (opts || {});
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    rate = ctx.sampleRate;
    chunks = [];
    detector = createSpeechDetector(rate);
    recording = true;
    const take = (data) => {
      if (!recording) return;
      chunks.push(data);
      const event = detector.push(data);
      // Called after this audio callback returns, since the handler stops the recording.
      if (event === 'silence' && onSilence) Promise.resolve().then(onSilence);
      if (event === 'no-speech' && onNoSpeech) Promise.resolve().then(onNoSpeech);
    };
    source = ctx.createMediaStreamSource(stream);
    sink = ctx.createGain(); // silent: the capture node must be connected to run, but not heard
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    node = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        workletLoaded = workletLoaded || ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
        await workletLoaded;
        node = new AudioWorkletNode(ctx, 'narrator-capture');
        node.port.onmessage = (e) => take(e.data);
      } catch { node = null; workletLoaded = null; }
    }
    if (!node) { // older browsers
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    source.connect(node);
    node.connect(sink);
    timer = setTimeout(() => onLimit && onLimit(), MAX_SECONDS * 1000);
  }

  // Release the microphone at once: on iPhone an open mic keeps audio in "call" mode (quieter,
  // possibly the earpiece), so it must not stay open after the question.
  function release() {
    recording = false;
    clearTimeout(timer);
    try { source && source.disconnect(); node && node.disconnect(); sink && sink.disconnect(); } catch { /* already disconnected */ }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = source = node = sink = null;
  }

  // Stops and returns { audio: base64 WAV, seconds }, or null if too short to be a question.
  // Silence after the last speech is trimmed to TRAIL_MS (shorter audio for Perceptron).
  function stop() {
    if (!recording) return null;
    release();
    let length = chunks.reduce((n, c) => n + c.length, 0);
    if (detector && detector.heard) length = Math.min(length, Math.ceil((detector.lastSpeechMs + TRAIL_MS) / 1000 * rate));
    const all = new Float32Array(length);
    let offset = 0;
    for (const c of chunks) {
      if (offset >= length) break;
      const part = c.length > length - offset ? c.subarray(0, length - offset) : c;
      all.set(part, offset); offset += part.length;
    }
    chunks = [];
    const seconds = length / rate;
    if (seconds < MIN_SECONDS) return null;
    return { audio: toBase64(encodeWav(downsample(all, rate))), seconds };
  }

  function cancel() { release(); chunks = []; }

  const api = { start, stop, cancel, downsample, encodeWav, toBase64, createSpeechDetector, TARGET_RATE, MAX_SECONDS, MIN_SECONDS,
    SILENCE_MS, NO_SPEECH_MS, TRAIL_MS,
    get recording() { return recording; } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Recorder = api;
})(this);
