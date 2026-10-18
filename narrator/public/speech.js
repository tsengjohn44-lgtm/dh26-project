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

  // Must run inside a user gesture (the Start tap) for iOS to allow audio.
  function unlock() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const blip = ctx.createBufferSource(); // one silent sample: completes the iOS unlock
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start();
  }

  // A clip fills `chunks` (Float32Array) while it downloads; the player drains them.
  function makeClip(text) {
    const clip = { text, chunks: [], rate: 24000, done: false, t0: performance.now(), wake: null, abort: new AbortController() };
    clip.notify = () => { const w = clip.wake; clip.wake = null; if (w) w(); };
    download(clip, generation);
    return clip;
  }

  async function download(clip, gen) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clip.text.slice(0, MAX_TEXT) }),
          signal: clip.abort.signal,
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
        if (!enabled || attempt >= RETRIES || clip.chunks.length) { stats.lastError = e.message || String(e); onChange(); break; }
      }
    }
    clip.done = true;
    clip.notify();
  }

  // Queue an alert to be spoken.
  function say(text) {
    if (!enabled || !ctx || !text) return;
    if (interrupt) cancel();
    stats.lastError = '';
    const clip = makeClip(text);
    clip.immediate = !queue.length; // nothing ahead of it: its delay is the true speech delay
    queue.push(clip);
    onChange();
    pump();
  }

  // Play queued clips one after another, in order.
  async function pump() {
    if (playing) return;
    playing = true;
    const gen = generation;
    while (queue.length && gen === generation) {
      await playClip(queue[0], gen);
      if (gen !== generation) return; // cancelled; a newer loop owns playback
      queue.shift();
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
      if (gen !== generation) return;
      if (index < clip.chunks.length) {
        const data = clip.chunks[index++];
        const buffer = ctx.createBuffer(1, data.length, clip.rate);
        buffer.copyToChannel(data, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => sources.delete(src);
        if (next < ctx.currentTime) { // first chunk, or the download fell behind playback
          next = ctx.currentTime + START_DELAY;
          if (index === 1 && clip.immediate) { stats.delayMs = Math.round(performance.now() - clip.t0); onChange(); }
        }
        src.start(next);
        sources.add(src);
        next += buffer.duration;
        continue;
      }
      if (clip.done) break;
      await wait((resolve) => { clip.wake = resolve; }); // more audio, or the end of the download
    }
    const remaining = next - ctx.currentTime;
    if (remaining > 0 && gen === generation) await wait((resolve) => setTimeout(resolve, remaining * 1000));
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
    say,
    cancel,
    stats,
    get pending() { return queue.length; },
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; if (!v) cancel(); },
    get interrupt() { return interrupt; },
    set interrupt(v) { interrupt = v; },
    set onChange(fn) { onChange = fn; },
  };
})();
