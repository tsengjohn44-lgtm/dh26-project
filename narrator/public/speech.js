// Speaks alerts with ElevenLabs (via POST /api/speak) and plays them through Web Audio.
//
// Queue mode (default): every alert is played, in order, none dropped. Each clip starts
// generating as soon as it is queued, so later clips are usually ready by the time the
// earlier ones finish and play back to back.
// Interrupt mode: a new alert cuts off the clip that is playing and drops queued older ones.
//
// Web Audio (rather than <audio> elements) because iOS only lets a page play sound after a
// tap; one AudioContext unlocked in the Start tap can then play every later clip.
window.Speech = (() => {
  const MAX_TEXT = 500;
  const RETRIES = 1; // one retry per clip, so a network blip doesn't lose an alert

  let ctx = null;
  let enabled = true;
  let interrupt = false;
  let generation = 0;  // bumps on cancel: stale playback loops and fetches stop
  let playing = false;
  let current = null;  // AudioBufferSourceNode playing now
  const queue = [];    // { text, audio: Promise<AudioBuffer|null> }
  let onChange = () => {};

  // Must run inside a user gesture (the Start tap) for iOS to allow audio.
  function unlock() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const blip = ctx.createBufferSource(); // one silent sample: completes the iOS unlock
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start();
  }

  async function synthesize(text, gen) {
    for (let attempt = 0; ; attempt++) {
      try {
        const t0 = performance.now();
        const res = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
        });
        if (res.status === 503) { enabled = false; throw new Error(await res.text()); } // no key on the server
        if (!res.ok) throw new Error(await res.text());
        const bytes = await res.arrayBuffer();
        if (gen !== generation) return null;
        const audio = await ctx.decodeAudioData(bytes);
        stats.lastMs = Math.round(performance.now() - t0);
        return audio;
      } catch (e) {
        if (gen !== generation || !enabled || attempt >= RETRIES) { stats.lastError = e.message || String(e); onChange(); return null; }
      }
    }
  }

  // Queue an alert to be spoken.
  function say(text) {
    if (!enabled || !ctx || !text) return;
    if (interrupt) cancel();
    stats.lastError = '';
    queue.push({ text, audio: synthesize(text, generation) });
    onChange();
    pump();
  }

  // Play queued clips one after another, in order.
  async function pump() {
    if (playing) return;
    playing = true;
    const gen = generation;
    while (queue.length && gen === generation) {
      const audio = await queue[0].audio; // already generating since it was queued
      if (gen !== generation) return;     // cancelled meanwhile; a newer loop owns playback
      queue.shift();
      onChange();
      if (audio) await play(audio);
    }
    if (gen === generation) { playing = false; onChange(); }
  }

  function play(buffer) {
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => { if (current === src) current = null; resolve(); };
      current = src;
      src.start();
    });
  }

  // Stop the clip that is playing and drop everything queued.
  function cancel() {
    generation++;
    queue.length = 0;
    playing = false;
    if (current) { const src = current; current = null; try { src.stop(); } catch { /* already ended */ } }
    onChange();
  }

  const stats = { lastMs: 0, lastError: '' };

  return {
    unlock,
    say,
    cancel,
    stats,
    get pending() { return queue.length + (current ? 1 : 0); },
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; if (!v) cancel(); },
    get interrupt() { return interrupt; },
    set interrupt(v) { interrupt = v; },
    set onChange(fn) { onChange = fn; },
  };
})();
