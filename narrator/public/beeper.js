// Proximity beeps from the ESP8266 distance sensor (readings arrive over Server-Sent Events from
// GET /api/distance/stream). Silent beyond 2 m; faint slow ticks from 2 m that get louder,
// faster and higher as an obstacle gets closer; fast, loud beeps at 10 cm or less. While the
// voice is speaking, beeps duck (quieter) except at 10 cm or less.
//
// Uses the AudioContext that speech.js unlocks in the Start tap (iOS only plays audio from a
// context unlocked by a tap). Runs in the browser (window.Beeper); beepParams is also
// exported for Node tests.
(function (root) {
  const FAR = 2.0;           // m: silent beyond this
  const NEAR = 0.10;         // m: at or below, fastest and loudest
  const SLOW = 1.2;          // s between beeps at FAR
  const FAST = 0.08;         // s between beeps at NEAR
  const MIN_GAIN = 0.03;     // loudness at FAR, relative to full
  const LOW_HZ = 650, HIGH_HZ = 1200;
  const PEAK = 0.5;          // oscillator amplitude at full volume: headroom under the voice
  const STALE_MS = 1500;     // no reading for this long: sensor offline, silent
  const LOOKAHEAD = 0.15;    // s of beeps scheduled ahead on the audio clock (steady timing)
  const TICK_MS = 50;
  const DUCK = 0.3;          // beep level while the voice speaks

  // Beep settings for a distance, or null for silence. intensity 0.5-2 (1 = the base curve):
  // closeness is raised to 1/intensity, so higher intensity ramps up sooner.
  function beepParams(metres, intensity = 1) {
    if (metres === null || metres === undefined || !Number.isFinite(metres) || metres > FAR) return null;
    if (metres <= NEAR) return { interval: FAST, gain: 1, freq: HIGH_HZ, urgent: true };
    const closeness = (FAR - metres) / (FAR - NEAR);          // 0 at 2 m, 1 at 10 cm
    const p = Math.pow(closeness, 1 / intensity) ** 2;         // squared: quiet far, steep close
    return {
      interval: SLOW * Math.pow(FAST / SLOW, p),               // log scale, 1.2 s -> 0.08 s
      gain: MIN_GAIN + (1 - MIN_GAIN) * Math.pow(p, 1.5),
      freq: LOW_HZ + (HIGH_HZ - LOW_HZ) * p,
      urgent: false,
    };
  }

  function createBeeper({ getContext, isSpeaking, now = () => performance.now(), EventSourceImpl = root.EventSource } = {}) {
    let enabled = true;
    let volume = 0.6;
    let intensity = 1;
    let reading = null;    // { metres, at: local ms when measured }
    let source = null;     // EventSource
    let timer = null;
    let master = null;     // GainNode: volume x ducking
    let lastBeep = -Infinity;
    let onChange = () => {};
    let lastState = '';

    function state() {
      if (!reading || now() - reading.at > STALE_MS) return 'offline';
      return reading.metres === null ? 'clear' : `${reading.metres.toFixed(2)}`;
    }

    function current() {
      if (!enabled || !reading || now() - reading.at > STALE_MS) return null;
      return beepParams(reading.metres, intensity);
    }

    function ensureMaster(ctx) {
      if (master && master.context === ctx) return master;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      return master;
    }

    function beep(ctx, t, params) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(params.freq, t);
      const peak = PEAK * params.gain;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.005);          // 5 ms attack: no click
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.065);   // 60 ms decay
      osc.connect(env);
      env.connect(master);
      osc.start(t);
      osc.stop(t + 0.08);
    }

    function tick() {
      const s = state();
      if (s !== lastState) { lastState = s; onChange(s); }
      const ctx = getContext();
      if (!ctx) return;
      ensureMaster(ctx);
      const params = current();
      const t = ctx.currentTime;
      const level = !params ? 0 : volume * (isSpeaking() && !params.urgent ? DUCK : 1);
      master.gain.setTargetAtTime(level, t, 0.025);                // ~80 ms to settle: no click
      if (!params) return;
      // Next beep is due one (current) interval after the last one, so getting closer speeds
      // the beeps up right away instead of after the old, longer interval.
      let due = Math.max(lastBeep + params.interval, t + 0.01);
      while (due < t + LOOKAHEAD) {
        beep(ctx, due, params);
        lastBeep = due;
        due += params.interval;
      }
    }

    function start() {
      stop();
      if (EventSourceImpl) {
        source = new EventSourceImpl('/api/distance/stream');
        source.onmessage = (e) => {
          try {
            const d = JSON.parse(e.data);
            reading = { metres: typeof d.metres === 'number' ? d.metres : null, at: now() - (Number(d.ageMs) || 0) };
          } catch { /* ignore malformed events */ }
        };
      }
      timer = setInterval(tick, TICK_MS);
      tick();
    }

    function mute() {
      const ctx = getContext();
      if (master && ctx) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setValueAtTime(0, ctx.currentTime); }
    }

    function stop() {
      if (source) { source.close(); source = null; }
      if (timer) { clearInterval(timer); timer = null; }
      reading = null;
      lastBeep = -Infinity;
      mute();
      if (lastState !== 'off') { lastState = 'off'; onChange('off'); }
    }

    return {
      start,
      stop,
      tick,
      get state() { return state(); },
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; if (!enabled) mute(); },
      get volume() { return volume; },
      set volume(v) { volume = Math.min(1, Math.max(0, Number(v))); },
      get intensity() { return intensity; },
      set intensity(v) { intensity = Math.min(2, Math.max(0.5, Number(v))); },
      set onChange(fn) { onChange = fn; },
    };
  }

  const api = { beepParams, createBeeper, FAR, NEAR, STALE_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BeeperLib = api;
    root.Beeper = createBeeper({
      getContext: () => root.Speech && root.Speech.context,
      isSpeaking: () => !!(root.Speech && root.Speech.enabled && root.Speech.pending > 0),
    });
  }
})(this);
