// Speaks alerts with ElevenLabs (via POST /api/speak) and plays them through Web Audio.
//
// Streaming: the server sends raw 16-bit PCM, and each chunk is scheduled for playback as soon
// as it arrives, so speech starts ~0.2 s after the request instead of after the whole clip has
// downloaded and decoded (~0.9 s+ with MP3).
//
// Queue mode (default): every alert is played, in order, none dropped. Each clip starts
// generating as soon as it is queued, so later clips are ready when earlier ones finish.
// Interrupt mode: a new alert cuts off the clip that is playing and drops queued older ones.
//
// Web Audio (rather than <audio> elements) because iOS only lets a page play sound after a
// tap; one AudioContext unlocked in the Start tap can then play every later clip.
window.Speech = (() => {
  const MAX_TEXT = 500;
  const RETRIES = 1;          // one retry if a clip fails before any audio arrives
  const START_DELAY = 0.05;   // s of headroom when scheduling the first chunk (absorbs jitter)
  const MIN_CHUNK = 0.06;     // s; network chunks are merged up to this before scheduling
  const STALL_MS = 8000;      // a download that receives nothing for this long is given up

  let ctx = null;
  let enabled = true;
  let interrupt = false;
  let generation = 0;         // bumps on cancel: stale playback loops and fetches stop
  let playing = false;
  const queue = [];           // clips waiting or playing, see makeClip()
  const sources = new Set();  // scheduled AudioBufferSourceNodes, stopped on cancel
  let wakePlayback = null;    // resolves the playback loop's current wait (cancel)
  let onChange = () => {};
  const stats = { delayMs: 0, lastError: '' };

  // iOS mutes Web Audio while the ring/silent switch is set to silent (a video still plays), so
  // with the switch on silent the voice and beeps were inaudible. The "playback" audio session
  // (Safari 17+) makes the page play like a video. Older iOS: playing a silent looping <audio>
  // element from a tap moves the page into the same playback session.
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let keepAlive = null;
  function usePlaybackSession() {
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch { /* unsupported value */ }
      return;
    }
    if (!IS_IOS) return; // elsewhere Web Audio already follows the media volume
    if (!keepAlive) {
      keepAlive = new Audio(silentWavUrl());
      keepAlive.loop = true;
      keepAlive.setAttribute('playsinline', '');
    }
    keepAlive.play().catch(() => {});
  }

  function silentWavUrl() {
    const samples = 2205; // 0.1 s at 22050 Hz
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 22050, true); v.setUint32(28, 44100, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // 🎤 Ask records from the microphone, which the "playback" session doesn't allow on iPhone.
  // So the session is "play-and-record" only while recording, and back to "playback" as soon as
  // the mic is released, so the answer plays loudly through the speaker again.
  function setRecording(on) {
    if (!navigator.audioSession) return;
    try { navigator.audioSession.type = on ? 'play-and-record' : 'playback'; } catch { /* unsupported value */ }
  }

  // Must run inside a user gesture (the Start tap) for iOS to allow audio.
  function unlock() {
    usePlaybackSession();
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.onstatechange = () => { if (ctx.state === 'running' && stats.lastError === PAUSED) { stats.lastError = ''; onChange(); } };
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const blip = ctx.createBufferSource(); // one silent sample: completes the iOS unlock
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start();
  }

  // iOS suspends audio when the page is hidden or another app takes the speaker, and only a tap
  // may turn it back on. The app restarts itself when the page comes back, without a tap, so the
  // voice stayed silent: the next tap anywhere on the page now resumes it.
  const PAUSED = 'tap the screen to turn sound back on';
  const resumeOnTap = () => { if (ctx && ctx.state !== 'running') unlock(); };
  document.addEventListener('touchend', resumeOnTap, { capture: true, passive: true });
  document.addEventListener('click', resumeOnTap, { capture: true });

  // A clip fills `chunks` (Float32Array) while it downloads; the player drains them.
  function makeClip(text, urgent) {
    const clip = { text, urgent, chunks: [], rate: 24000, done: false, cancelled: false, sources: new Set(), t0: performance.now(), wake: null, abort: new AbortController() };
    clip.notify = () => { const w = clip.wake; clip.wake = null; if (w) w(); };
    download(clip, generation);
    return clip;
  }

  async function download(clip, gen) {
    for (let attempt = 0; ; attempt++) {
      // Watchdog: give up on a download that receives nothing for STALL_MS, so a hung request
      // can't keep the queue (and the app's paused-while-speaking camera) waiting forever.
      const attemptAbort = new AbortController();
      const onCancel = () => attemptAbort.abort();
      clip.abort.signal.addEventListener('abort', onCancel, { once: true });
      let watchdog = null;
      const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => attemptAbort.abort(), STALL_MS); };
      kick();
      try {
        const res = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clip.text.slice(0, MAX_TEXT) }),
          signal: attemptAbort.signal,
        });
        if (res.status === 503) { enabled = false; throw new Error(await res.text()); } // no key on the server
        if (!res.ok) throw new Error(await res.text());
        clip.rate = Number(res.headers.get('x-sample-rate')) || 24000;

        const reader = res.body.getReader();
        let odd = null;     // a byte left over when a chunk splits a 16-bit sample
        let pending = [];   // samples waiting to reach MIN_CHUNK
        let pendingLen = 0;
        const flush = () => {
          if (!pendingLen) return;
          const out = new Float32Array(pendingLen);
          let o = 0;
          for (const p of pending) { out.set(p, o); o += p.length; }
          clip.chunks.push(out);
          pending = []; pendingLen = 0;
          clip.notify();
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (gen !== generation) return;
          kick();
          let bytes = value;
          if (odd) { bytes = new Uint8Array(odd.length + value.length); bytes.set(odd); bytes.set(value, odd.length); odd = null; }
          if (bytes.length % 2) { odd = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const samples = new Float32Array(bytes.length / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          pending.push(samples); pendingLen += samples.length;
          // The first chunk goes out at once (lowest delay); later ones are merged a little.
          if (!clip.chunks.length || pendingLen >= clip.rate * MIN_CHUNK) flush();
        }
        flush();
        break;
      } catch (e) {
        if (gen !== generation || clip.abort.signal.aborted) return;
        const reason = attemptAbort.signal.aborted ? 'speech download stalled' : (e.message || String(e));
        if (!enabled || attempt >= RETRIES || clip.chunks.length) { stats.lastError = reason; onChange(); break; }
      } finally {
        clearTimeout(watchdog);
        clip.abort.signal.removeEventListener('abort', onCancel);
      }
    }
    clip.done = true;
    clip.notify();
  }

  // Queue an alert to be spoken. { urgent: true } (hazard alerts) cuts off a non-urgent clip that
  // is playing and drops queued non-urgent clips; urgent clips never cut each other and stay in
  // order. With the Interrupt setting on, every new alert cuts off everything (as before).
  function say(text, { urgent = false } = {}) {
    if (!enabled || !ctx || !text) return;
    if (interrupt) cancel();
    else if (urgent) dropNonUrgent();
    stats.lastError = '';
    if (ctx.state !== 'running') { // suspended or interrupted: queue it, and say how to get sound
      ctx.resume().catch(() => {});
      stats.lastError = PAUSED;
    }
    const clip = makeClip(text, urgent);
    clip.immediate = !queue.length; // nothing ahead of it: its delay is the true speech delay
    queue.push(clip);
    onChange();
    pump();
  }

  // Stop and remove every non-urgent clip (playing or queued), leaving urgent ones untouched.
  function dropNonUrgent() {
    const head = queue[0];
    for (const clip of queue.filter((c) => !c.urgent)) {
      clip.cancelled = true;
      clip.abort.abort();
      for (const src of clip.sources) { try { src.stop(); } catch { /* not started or already ended */ } sources.delete(src); }
      clip.sources.clear();
      queue.splice(queue.indexOf(clip), 1);
    }
    // The playback loop is waiting on the cut clip (for audio or for it to end): wake it so it
    // moves on now. Not when an urgent clip is playing: that wait belongs to it.
    if (head && head.cancelled && wakePlayback) { const w = wakePlayback; wakePlayback = null; w(); }
  }

  // Play queued clips one after another, in order.
  async function pump() {
    if (playing) return;
    playing = true;
    const gen = generation;
    while (queue.length && gen === generation) {
      const clip = queue[0];
      await playClip(clip, gen);
      if (gen !== generation) return; // cancelled; a newer loop owns playback
      const i = queue.indexOf(clip);  // may already be gone (cut by an urgent alert)
      if (i >= 0) queue.splice(i, 1);
      onChange();
    }
    playing = false;
    onChange();
  }

  const wait = (fn) => new Promise((resolve) => { wakePlayback = resolve; fn(resolve); });

  // Schedule a clip's chunks back to back as they arrive; resolve when its audio has ended.
  async function playClip(clip, gen) {
    let next = 0;
    let index = 0;
    for (;;) {
      if (gen !== generation || clip.cancelled) return;
      if (index < clip.chunks.length) {
        const data = clip.chunks[index++];
        const buffer = ctx.createBuffer(1, data.length, clip.rate);
        buffer.copyToChannel(data, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => { sources.delete(src); clip.sources.delete(src); };
        if (next < ctx.currentTime) { // first chunk, or the download fell behind playback
          next = ctx.currentTime + START_DELAY;
          if (index === 1 && clip.immediate) { stats.delayMs = Math.round(performance.now() - clip.t0); onChange(); }
        }
        src.start(next);
        sources.add(src);
        clip.sources.add(src);
        next += buffer.duration;
        continue;
      }
      if (clip.done) break;
      await wait((resolve) => { clip.wake = resolve; }); // more audio, or the end of the download
    }
    const remaining = next - ctx.currentTime;
    if (remaining > 0 && gen === generation && !clip.cancelled) await wait((resolve) => setTimeout(resolve, remaining * 1000));
  }

  // Stop the clip that is playing and drop everything queued.
  function cancel() {
    generation++;
    for (const clip of queue) clip.abort.abort();
    queue.length = 0;
    playing = false;
    for (const src of sources) { try { src.stop(); } catch { /* not started or already ended */ } }
    sources.clear();
    if (wakePlayback) { const w = wakePlayback; wakePlayback = null; w(); }
    onChange();
  }

  return {
    unlock,
    setRecording,
    say,
    cancel,
    stats,
    get pending() { return queue.length; },
    get soundPaused() { return enabled && !!ctx && ctx.state !== 'running'; }, // a tap resumes it
    get context() { return ctx; }, // the AudioContext unlocked by the Start tap (shared with beeper.js)
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; if (!v) cancel(); },
    get interrupt() { return interrupt; },
    set interrupt(v) { interrupt = v; },
    set onChange(fn) { onChange = fn; },
  };
})();
