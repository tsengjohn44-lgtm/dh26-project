# AGENTS.md: Live Scene Narrator (DubHacks '26)

Guide for AI coding agents working in this repo. It describes the code as it exists and the plan for what comes next. `CLAUDE.md` only imports this file, so every agent reads the same guide.

**System overviews live in [`docs/`](docs/README.md)**: architecture, vision, speech, proximity sensor, UI, server/API, testing, and [`docs/optimization.md`](docs/optimization.md), every speed and efficiency change with measurements. Each system doc ends with a **Design decisions** table (why it's built that way, and what was rejected); `docs/architecture.md` also explains why the project stays on plain Node + HTML/JS rather than a framework. This file covers conventions, decisions and open questions for agents.

> **Stack note.** An earlier plan for this project used Next.js/TypeScript on Vercel, Grok text-to-speech, and "rough distances" in speech. **That is not what was built**: the code is a zero-dependency Node server plus static HTML/JS in `narrator/`. Speech uses **ElevenLabs** (not Grok). Distances were deliberately removed, except stair counts. Don't start a Next.js migration or switch speech providers without asking the team (see "Decisions").

---

## 1. What the app does

A phone web page that streams the rear camera to the **Perceptron Mk1.5** vision-language API. It shows very short, navigation-focused alerts for a **blind pedestrian**:

- **Hazards** (top priority): things approaching fast, stairs, curbs, drop-offs, potholes, uneven ground, obstacles at foot, body or head height.
- **Navigation cues:** doors, crosswalks, intersections, elevators, turns.
- **Large readable text:** building names, room names and numbers, major signs, quoted exactly.

Rules for the output:
- At most 12 words, on one line.
- Positions are only **left, ahead or right**, plus **"close"** for anything within about 2 steps.
- **Focus on what is directly ahead:** the center of the frame and the ground about to be walked on. Ignore far-away things and things at the edges of the frame, unless they are moving toward the person.
- **No distances or step counts**, except stairs. Stairs always say **up or down** and give a **cautious minimum** count: "Stairs going down ahead, at least 6 steps." Underestimating is preferred to overestimating; `filter.js` also scales the model's count down by 0.75.
- If nothing new and important is visible, the model replies **`n/a`**. The app then shows nothing new.
- The app must **not repeat** what it has already said about the current view.

Each new alert is also **spoken with ElevenLabs** (`eleven_v4_turbo`):
- **Queue mode** (default): every alert is spoken, in order, none dropped. Audio for each alert starts generating as soon as it is queued, so clips play back to back.
- **Interrupt mode** (toggle): a new alert cuts off the clip that is playing and drops older queued clips.

Visually, the UI is a large high-contrast caption with an `aria-live` region.

## 2. Run it

```sh
cd narrator
echo 'PERCEPTRON_API_KEY=...' > .env      # gitignored; get a key at https://platform.perceptron.inc/
node server.js                            # Node >= 18, no npm install
```

- Desktop: `http://localhost:8080`. A webcam works, since localhost counts as a secure context.
- Phone (same Wi-Fi): `https://<lan-ip>:8443`. The server creates a self-signed certificate in `narrator/certs/` (gitignored), prints the URL, and draws it as a **QR code** in the terminal: scan it with the phone's camera. Tap through the certificate warning.
  - Phones only allow camera access over HTTPS.
  - The certificate is tied to the LAN IP at the time it was made. If the IP changes, delete `narrator/certs/` and restart.
- Off-Wi-Fi alternative: `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`.
- Environment variables (in `narrator/.env` or the shell):
  - `PERCEPTRON_API_KEY` (required)
  - `PERCEPTRON_MODEL` (default `perceptron-mk1.5`)
  - `ELEVENLABS_API_KEY` (optional; without it the app runs silently and `/api/speak` returns 503)
  - `ELEVENLABS_MODEL` (default `eleven_v4_turbo`)
  - `ELEVENLABS_VOICE_ID` (default `JBFqnCBsd6RMkjVDRZzb`, a default ElevenLabs voice)
  - `ELEVENLABS_SAMPLE_RATE` (default `24000`; raw PCM output. 44100 requires the ElevenLabs Pro tier and is refused on the current key)
  - `ELEVENLABS_TAG` (default `[rapidly]`, prefixed to the text for v3/v4 models; set it empty to disable)
  - `ELEVENLABS_EARLY` (default on; `0` turns off early speech, which starts generating audio in `describe()`)
  - `ELEVENLABS_SPEED` (default `1.2`; `voice_settings.speed`, which only non-v3/v4 models such as Flash honor)
  - `PORT` (8080), `HTTPS_PORT` (8443)
  - `DISTANCE_PORT` (default 5000): plain-HTTP port for the ESP8266 distance sensor. **On macOS, port 5000 is usually taken by the AirPlay Receiver**: turn it off (System Settings > General > AirDrop & Handoff), or use another port. The server says so at startup. `/distance` also works on `PORT`.
- After changing files under `public/`, hard-refresh the phone. After changing `server.js` or `prompt.js`, restart the server.

## 3. Repo map

```
AGENTS.md            this file: the guide for all AI agents
CLAUDE.md            one line, "@AGENTS.md", so Claude Code loads this file
README.md            repo credits (.claude/ agents and skills come from ECC, MIT)
docs/                system overviews + optimization.md (start at docs/README.md)
esp8266_main.ino     ESP8266 + ultrasonic sensor: POSTs distance=<m>|Out_of_Range to the server every ~200 ms (own buzzer < 5 cm)
.claude/             shared agent definitions and skills (code-reviewer, build-error-resolver, …)
narrator/
  server.js          static file server + POST /api/describe proxy to Perceptron; HTTP 8080 and HTTPS 8443
  prompt.js          SYSTEM_PROMPT + buildPayload(): the exact request sent to Perceptron
  eval/              tests: run.cjs (all offline checks), api_eval.cjs (real model), suites/, experiments/, baselines/; photos/ and results/ gitignored
  qr.js              tiny QR encoder: the phone link as a QR code in the startup log (QR=0 hides it)
  README.md          user-facing run/usage notes
  .env               PERCEPTRON_API_KEY (gitignored, never commit)
  certs/             auto-generated self-signed TLS cert (gitignored)
  public/
    index.html       UI: status pill, alert card, Voice/Start/Beeps bar, settings sheet, diagnostics overlay
    style.css        dark, frosted, phone-first design (one amber accent, ≥48 px targets, reduced-motion aware)
    ui.js            UI behaviour: settings sheet, Reasoning segmented control, tap-to-repeat, hazard highlight
    app.js           camera, frame capture, request scheduler, view-change detection, UI updates
    filter.js        shared by browser and Node: n/a and repeat filtering, viewChange()
    log.js           history of every reply and its outcome, in localStorage (window.Log; 🕘 History sheet)
    speech.js        ElevenLabs speech: audio queue, prefetch, interrupt, Web Audio playback (window.Speech)
    beeper.js        proximity beeps from the distance sensor: curve, scheduler, ducking (window.Beeper)
    recorder.js      microphone → 16 kHz WAV (base64) for spoken questions, end-of-speech detection (window.Recorder)
```

## 4. Architecture and data flow

```
Phone browser (public/app.js)                     Mac laptop (server.js)                 Perceptron
──────────────────────────────                    ──────────────────────                 ──────────
camera (rear, widest lens, 4:3)
  │ every `interval` ms (default 400),
  │ if fewer than 3 requests in flight
  ▼
grabFrame(): draw to canvas, ≤768 px, JPEG q0.7
checkViewChange(): 24×18 gray thumbnail vs the
  first frame of the current view; if
  viewChange > 0.5 → new view: clear `said`,
  move the old alert to history, show "Looking…"
  │
  │ POST /api/describe {image: dataURL, said: [last ≤5 alerts of this view]}
  ├──────────────────────────────────────────────▶ buildPayload() (prompt.js)
  │                                                  adds API key, POST ─────────────────▶ /v1/chat/completions
  │                                                                                         (~0.8–1.8 s)
  │◀───────────── text/plain reply + Server-Timing: api;dur=… ◀──────────────────────────
  ▼
handleReply():
  drop if an older frame than one already handled, or from an old view
  Filter.classifyReply(reply, said) → 'n/a' | 'repeat' | new alert
  new alert → caption; previous alert → history; push onto `said`
  status chip says why nothing changed ("nothing new" / "already said")
  latency chip: "total ms (model ms)"
```

**The API key never reaches the phone.** The browser only talks to `server.js`.

## 5. Modules in detail

### `narrator/server.js` (Node built-ins only)
- `loadDotEnv()` reads `narrator/.env`. The server exits with a message if `PERCEPTRON_API_KEY` is missing.
- `ensureCert()` creates a self-signed certificate with `openssl`. Its alternative names are localhost, 127.0.0.1 and every LAN IPv4 address.
- `serveStatic()` serves `public/` and blocks path traversal.
- `describe()` handles `POST /api/describe`:
  - It reads JSON (16 MiB limit), calls `buildPayload()`, and fetches Perceptron without streaming.
  - On success it returns the trimmed `choices[0].message.content` as `text/plain`, with a `Server-Timing: api;dur=<ms>` header.
  - It passes 429 and 503 statuses through with `Retry-After`. Other upstream errors become 502. Bad input gets a 400.
  - It aborts the upstream request if the client disconnects.
- **Distance sensor:**
  - `POST /distance` (form-encoded `distance=<metres>` or `distance=Out_of_Range`, from `esp8266_main.ino`) stores the latest reading. It replies 204, or 400 for bad values.
  - `GET /api/distance/stream` is a Server-Sent Events stream of `{metres, at, ageMs?}`. A newly connected phone gets the latest reading, with `ageMs`, so the phone can tell how old it is despite clock differences. Keep-alive every 15 s.
  - A separate plain-HTTP listener on `DISTANCE_PORT` serves the ESP, which can't verify our self-signed HTTPS certificate. Startup prints the `serverUrl` to put in the sketch.
- `speak()` handles `POST /api/speak` with `{text}`:
  - It calls ElevenLabs `POST /v1/text-to-speech/{voice}/stream?output_format=…` with `model_id` and `language_code: 'en'`, authenticated with the `xi-api-key` header.
  - It requests `output_format=pcm_<rate>`, prefixes `ELEVENLABS_TAG` to the text for v3/v4 models, and sends `voice_settings.speed`.
  - Each ElevenLabs request is a job created by `startSpeech(text)`. A job buffers its chunks, so a listener that arrives late still gets the whole clip: `speak()` replays the buffered chunks, then follows the job with `job.more()`.
  - **Early speech:** after Perceptron replies, `describe()` runs the same `Filter.classifyReply(reply, body.said)` the phone will run. If the reply would be a new alert, `startEarlySpeech()` starts its job immediately, stored by alert text.
    - `speak()` first checks for an early job (`takeEarlySpeech`) before starting a new one. The response header `X-Speech-Early: 1|0` says which happened.
    - At most 2 early jobs run at once; unclaimed jobs are aborted after 15 s.
    - The phone's `said` can be newer than the server's, so it may skip an alert; the early job then expires unused.
  - It streams the raw 16-bit little-endian mono PCM through to the browser, with headers `X-Sample-Rate` and `Server-Timing: tts;dur=<time to first byte>`.
  - It returns 503 without a key, passes 429 through, and turns other errors into 502.
  - The server does **no filtering**. All "is this worth showing" logic lives in the browser, because only the browser knows what is currently on screen while several requests are in flight.

### `narrator/prompt.js`
- `SYSTEM_PROMPT` is the single source of truth for model behavior. Sections: role, report priorities, "Be certain" (the door rule), style, the "Already said" rule, `n/a`, and examples.
- `buildPayload(body, model)`:
  - `body = { image, said?, reasoning?, style?, prevImage?, prevDtMs? }`; `style: 'classic'` uses `CLASSIC_PROMPT`, otherwise the safety prompt.
  - It sends one `image_url`, or a 2-frame `video_frames` clip when `prevImage` is given; clip mode is currently unused, see `MOTION_FRAMES`.
  - The user text lists "Already said (oldest first)".
  - Settings: `stream: false`, `temperature: 0.2`. `reasoning_effort` comes from `body.reasoning` (`none` by default, or `low`/`high`), with `max_completion_tokens` 40 for none and 2048 (`REASONING_BUDGET`) with reasoning. Low also gets the "think briefly" instruction (`BRIEF_REASONING`). The app's Fast + Low mode sends `none` and `low` requests for the same frame.
- The prompt examples are copied almost word for word by the model. Keep them generic. An example once said "Curb close ahead, crosswalk beyond it", and the model then added "crosswalk beyond it" to a photo with no crosswalk.

### `narrator/public/filter.js` (UMD: `window.Filter` in the browser, `require()` in Node)
- `cautiousStairCount(text)` multiplies the first "N steps/stairs" by `STAIR_COUNT_FACTOR = 0.75`, rounds down, with a minimum of 1, and fixes the plural. `classifyReply` applies it to every new alert, so the caption and `said` hold the discounted count.
- `classifyReply(raw, said)` returns `{text, reason}`:
  - It collapses whitespace and strips surrounding quotes.
  - `n/a` and "No change." become `reason: 'n/a'`.
  - A near-repeat of anything in `said` becomes `reason: 'repeat'`.
- `isRepeat(text, earlier)` compares **content words** between the reply and each earlier alert:
  - Content words are lowercase; filler is removed (ahead, sign, reads, close, step(s), at, least, …); stair counts are removed.
  - `up` and `down` are **kept**, so "Stairs up" ≠ "Stairs down".
  - If at least 60% of the reply's content words appear in an earlier alert, it's a repeat.
  - Exceptions, which make it new: a number not seen before (Room 214 → Room 215), or the reply now says "close" when the earlier alert didn't.
- `viewChange(a, b)` returns 1 − Pearson correlation of two grayscale thumbnails. 0 means the same view, about 1 means unrelated. It ignores exposure changes.

### `narrator/public/speech.js` (`window.Speech`)
- `unlock()` must run synchronously inside a user tap: `start()` calls it before any `await`, and the Voice toggle calls it too. It creates and resumes the `AudioContext` and plays one silent sample, which completes the iOS unlock.
- `say(text)` creates a clip with `makeClip()`, which starts `download()` at once. It then adds the clip to the queue and runs `pump()`.
- `download()` reads the PCM stream and converts the 16-bit samples to `Float32Array` chunks. It handles a byte split across network chunks. The first chunk is released immediately; later ones are merged to at least 60 ms. It retries once if the request fails before any audio arrives.
- `pump()` and `playClip()` play the queue head while its chunks arrive. Chunks are scheduled back to back as `AudioBufferSourceNode`s, with 50 ms of headroom before the first. Clips always play in order, even if a later one finished generating first.
- `stats.delayMs` is the time from `say()` to the first audio, recorded only for clips that had nothing queued ahead of them. The voice chip shows it.
- `cancel()` bumps `generation`, aborts the downloads, empties the queue, and stops every scheduled source. Interrupt mode calls it before queueing; so does `stop()`.
- A 503 from the server (no key) turns voice off and shows the reason in the voice chip.
- `app.js` calls `Speech.say(text)` for every new alert shown. Toggle state is remembered on the device (`localStorage` keys `voice` and `interrupt`).
- Tested in Node with fake fetch streams and a fake Web Audio clock, 12 checks:
  - audio starts on the first chunk, not after the full download
  - in-order playback when clips finish generating out of order, with no overlap and no loss
  - the next clip starts as soon as the previous ends
  - odd byte splits decode correctly
  - interrupt, retry, cancel, and voice off
- Real API through `server.js`: first audio arrives in about 200 ms (about 400 ms on a cold connection).
- **Not yet verified by listening on a phone.**

### Blur gate (`pickFrame()` in `app.js`, `Filter.sharpness()` in `filter.js`)
- **Why:** blurry frames give wrong answers. Five photos, blurred by shrinking to 110 px and enlarging back, went through the real API with the current prompt:
  - the room sign lost its numbers ("Class Room 71A, 71B…" became "Door ahead")
  - the stair count halved (10 → 5)
  - the crosswalk photo gained an invented "Cars approaching from right"
  - large text and big shapes survived
- **Score:** `Filter.sharpness(gray, w, h)` is the variance of the Laplacian on a 160×120 grayscale copy of the frame being sent, divided by its squared mean brightness. Without that division, a frame 40% darker scored 0.36× and looked blurry.
- **Threshold is relative:** a frame is blurry when its score is below `BLUR_RATIO = 0.5` × the 90th percentile of scores from the **same view** in the last `BLUR_WINDOW_MS = 8000`. A new view (thumbnail `viewChange` > 0.5, which blur barely affects) resets the reference, because scenes differ a lot: a sharp parking-lot photo scored 186, the atrium 4,795. With fewer than `BLUR_MIN_HISTORY = 4` scores, every frame counts as sharp.
- **Calibration:** 29 photos, with synthetic blur at 160 px. At 0.5×, the gate caught 29/29 box-blurred, 27/29 with 9 px and 25/29 with 5 px horizontal motion blur, and wrongly skipped 0/29 for camera shake (lowest 0.62×) or brightness changes. Horizontal motion blur slips through on scenes made of mostly horizontal lines (e.g. the corridor at 0.64×).
- **Motion:** a gyroscope `rotationRate` above `MAX_TURN_RATE = 90`°/s counts as blurry regardless of the score.
- **Flow:** a blurry frame isn't sent and is re-checked after `BLUR_RETRY_MS = 100`. After `BLUR_FALLBACK_MS = 2000` with nothing sharp, the sharpest skipped frame is sent, so the app is never blind for long.
- **Hint:** after `HINT_AFTER_MS = 3000` of continuous blur, `Speech.say('Hold the phone steady.')`, at most once per `HINT_COOLDOWN_MS = 15000`, and only with Voice on. It isn't added to `said`. While blurry, the status shows "Live · hold steady (blurry)".
- **🐞 overlay:** a `blur:` line with the verdict, sharpness, threshold, skip count and turn rate.
- **Tests:** 14 checks in the fake browser (in `narrator/eval/suites/app_test.cjs`). Not yet tuned on a real phone camera: real motion blur and noise in low light may need a different `BLUR_RATIO`.

### `narrator/public/beeper.js` (`window.Beeper`, `beepParams` also exported for Node)
- Readings come from `EventSource('/api/distance/stream')`, opened by `Beeper.start()` (in `start()`) and closed by `Beeper.stop()`.
- **Stale:** no reading for 1.5 s (`STALE_MS`) means silent, and the header chip says "sensor offline".
- **Curve** `beepParams(metres, intensity)`:
  - silent beyond 2 m or out of range
  - closeness `c = (2 − d)/1.9`, shaped `p = (c^(1/intensity))²`
  - interval `1.2 s × (0.08/1.2)^p`, gain `0.03 + 0.97·p^1.5`, pitch `650 + 550·p` Hz
  - ≤10 cm: every 0.08 s, full gain, marked `urgent`
  - At 1×: 2 m every 1.20 s at 3%; 1 m every 0.57 s at 17%; 0.5 m every 0.22 s at 51%; 0.25 m every 0.12 s at 79%.
- **Scheduler:** a lookahead loop runs every 50 ms and schedules 150 ms ahead on the audio clock. The next beep is due one *current* interval after the last, so approaching speeds up at once. Each beep is a sine `OscillatorNode` with a 5 ms attack and 60 ms decay.
- **Levels:** master gain = volume × 0.3 while `Speech.pending > 0` (ducking), except when `urgent`. It ramps with `setTargetAtTime` so it doesn't click.
- Shares `Speech.context`, the `AudioContext` unlocked in the Start tap.
- **UI:** Beeps row in the footer: the `#beeps` toggle, `#beepVolume` 0–200% (default 60; above 100% the loudest beep reaches full scale) and `#beepIntensity` 0.5–2 (default 1). They're saved in `localStorage` keys `beeps`, `beepVolume` and `beepIntensity`.
- **`Beeper.reading`:** `{ metres, ageMs }` for a valid fresh reading (2 cm–4 m, ≤1.5 s old), else `null`. `app.js` `sensorContext()` turns it into `sensor: { distanceM, heightM }` on describe, Fast + Low and ask requests when `#sensorToAi` is on (default on; height `#sensorHeight`, default 1 m; keys `sensorToAi`, `sensorHeight`). `prompt.js` `cleanSensor`/`sensorText` add one paragraph to the user message. The `#distance` header chip shows "obstacle 0.42 m", "sensor: clear" or "sensor offline".
- **Tests (simulated):** curve and scheduler, 20 checks with a fake audio clock and stream. Server stream, 11 checks with real HTTP. App wiring, 5 checks in the fake browser.

### UI (`index.html`, `style.css`, `ui.js`): redesigned 2026-10-18
- **Main screen:**
  - a status pill: `#status` with a red pulsing dot when live, plus the `#distance` badge
  - ⚙ `#settingsBtn` and ⇄ `#flip`
  - the alert card `#current` (28–32 px; amber left edge when `.hazard`)
  - the last two `#history` lines (the rest hidden by CSS)
  - a bottom bar: Voice quick toggle `#voice`, Start/Stop `#start`, Beeps quick toggle `#beeps`
- **Settings sheet** (`#sheet`): one scrolling list, no sub-menus.
  - Speech: `#interrupt`, `#pauseSpeaking`
  - Vision: Reasoning as a 4-button segmented control that drives the hidden `<select id="reasoning">`; `#interval`
  - Proximity: `#beepVolume`, `#beepIntensity`
  - Diagnostics: `#debugBtn` as a switch row (`aria-pressed`)
  - The timing chips `#latency`, `#lens` and `#voiceStatus` moved into the diagnostics overlay.
- **All element IDs used by `app.js` were kept**, so `app.js` didn't change for the redesign, and its 73 fake-browser checks pass unchanged.
- **History (🕘 `#historyBtn`, `#logSheet`):** `log.js` keeps the last 1,000 replies on the phone (`replyLog`), each with its outcome: `alert`, `correction`, `answer`, `hint`, or dropped as `repeat`, `n/a`, `late`, `error`. `app.js` `logReply()` is called at each decision point. The server stores no replies. Details in `docs/ui.md`.
- **`ui.js`** (loaded after `app.js`; if it fails, the controls still work as plain form controls):
  - Sheet: open/close via ⚙, ✕, backdrop, Escape, or a swipe down on the handle/header; `aria-expanded` and focus are handled.
  - Segmented control: sets `#reasoning` and dispatches `change`, so `app.js` saves it.
  - Tap or Enter on the alert card: `Speech.say(current alert)`.
  - A `MutationObserver` on `data-alert`: `.hazard` for stairs, curb, drop, hole, close, car, bike or approaching; a 40 ms vibration on Android; an arrival animation.
  - Tests: 13 fake-DOM checks.
- **Visual check:** rendered with macOS Quick Look (`qlmanage -t`, WebKit) at 360 and 412 px in iframes. Animations had to be disabled in the preview, because Quick Look snapshots frame 0. Found and fixed: the sheet was slightly see-through, so it's now opaque with `z-index: 20`.

### `narrator/public/app.js`
- **Camera:** `openCamera()` requests 1920×1440 at 4:3. On most phones that uses the full sensor; 16:9 crops it. Then `useWidestLens()`:
  1. It picks a device whose label matches `/ultra\s*-?\s*wide/i`. iOS Safari exposes "Back Ultra Wide Camera"; labels are only available after camera permission is granted.
  2. If the track supports `zoom` below the current value, it applies the minimum zoom. Some Android phones support this.
  3. Otherwise it keeps the default camera.
  - `showLens()` shows the camera name, zoom and resolution in the header.
- **Scheduler:** `loop()` calls `sendFrame()` every `interval` ms (slider 0.3–3 s, default 0.4 s) while fewer than `MAX_IN_FLIGHT = 3` requests are open.
  - Each request has a `seq` and a `view` id.
  - `handleReply` drops replies where `seq < shownSeq` or `view !== viewId`.
  - Errors back off for at least 2 s, or `Retry-After` if longer.
  - Each request times out after 20 s.
- **View change:** `checkViewChange()` runs on every frame and compares against `viewThumb`, the first frame of the current view. Above `VIEW_CHANGE = 0.5` it starts a new view:
  - `viewId++` and `said = []`
  - the old alert moves to history
  - the caption shows "Looking…"
  - if the new view gets `n/a`, the caption shows "Nothing important in view."
- **Screen orientation:** tilting the phone, e.g. pointing it at the ground, can make Android rotate the screen 180°. Chrome then kept drawing the camera at the old angle, so the preview and the frames sent to the model were upside down.
  - Fix: `start()` calls `lockPortrait()` within the tap. On phones (`pointer: coarse`) this enters fullscreen and runs `screen.orientation.lock('portrait-primary')`, because Chrome only allows the lock in fullscreen. `stop()` unlocks and exits fullscreen.
  - Fallback when locking isn't possible: a `screen.orientation` `change` listener detects a 180° turn while running, then calls `resetView()` and `reopenCamera()`.
  - `reopenCamera()` runs camera reopens one at a time; overlapping reopens leave a camera running. The switch-camera button uses it too.
  - Fullscreen can end early: the first camera permission prompt, a back swipe or an app switch. While running, the next tap anywhere except Start/Stop calls `lockPortrait()` again.
  - `cameraToken`: `stopCamera()` bumps it, and `openStream()` closes a camera that finishes opening after a newer stop or reopen. Without it, a Stop during opening left the camera light on. `start()` also returns early if Stop was tapped while the camera was opening.
  - `grabFrame()` returns null while no camera is attached, so a stale (possibly upside-down) frame is never sent during a reopen.
  - 180° turns are caught three ways (`checkScreenTurn`): the `screen.orientation` `change` event, the older window `orientationchange` event, and polling the angle every 500 ms while running. A browser may not report a 180° turn through every channel.
  - **Tap the 🐞 button** (or open the page with `?debug`) to show a diagnostics overlay (`#debug`); the choice is remembered (`localStorage` key `debug`). It shows: a thumbnail of the last frame sent to Perceptron; the camera frame's own rotation tag (WebCodecs `VideoFrame.rotation`/`.flip`, read from a cloned track via `MediaStreamTrackProcessor`, with every change logged); how the phone is held (from gravity, e.g. "flat, screen up"); the version label (`VERSION` in `app.js`, fixed, to confirm the phone has the latest code); the screen type, angle and `window.orientation`; fullscreen on/off and the lock result, including the exact error if `lock()` was refused; video and track sizes; gravity x,y,z from `devicemotion`; how many times the camera was reopened; and the last 8 orientation/fullscreen events.
  - **Android flip (diagnosed 2026-10-17 on Android Edge with the 🐞 overlay):** the browser turns the camera image 180° when the phone's top edge dips below its bottom edge, e.g. lying flat or aiming at the ground. It turns it back when the phone is lifted. This also flips the frames sent to the AI.
    - It's independent of the screen lock: it happened with the lock in place, and the screen stayed at `portrait-primary 0°`.
    - The browser reports it nowhere: `VideoFrame.rotation` stays 0°.
    - Fix (Android only, `FLIP_CORRECTION`): `updateFrameTurn()` predicts the flip from `devicemotion` gravity y. It turns ON below `FLIP_ON_Y = -0.5` and off above `FLIP_OFF_Y = +0.5`, and is ignored when the phone is on its side. While ON, the preview gets `rotate(180deg)` and `grabFrame()` draws with a 180° canvas transform, so the AI gets upright frames.
    - The tipping point at y≈0 is an assumption. With 🐞 on, `detectBrowserFlip()` compares consecutive raw frames, logs "browser turned image 180° (seen in picture)" with the gravity reading at that moment, and so checks the thresholds. **Not yet confirmed on the device.**
    - The re-lock-on-tap listener now uses `click`. With `pointerdown`, `requestFullscreen` failed with "TypeError: Permissions check failed": on touch screens a tap only counts once the finger lifts.
  - Simulated in Node against the real `app.js` with a fake browser, 33 checks pass: Stop while opening, overlapping reopens, 180° vs 90° turns, a turn while stopped, a 180° turn with no event (caught by polling), `grabFrame` with no camera, fullscreen lock/re-lock/unlock, desktop not locking, the `?debug` overlay shown or hidden, the 🐞 toggle, frame-rotation change logging, the phone-held description, the sent-frame thumbnail, flip correction on/off with hysteresis (preview and AI frames), no correction on iPhone, and the picture-based flip detector.
  - Not yet verified on a device.
- **Lifecycle:** `start()` and `stop()` bump `runId` so stale loops and replies are ignored. `resetView()` runs on start, stop and camera switch. The screen wake lock is held while running. The app stops when the page is hidden and resumes when it is visible again.
- **State:**
  - `said` holds up to 5 alerts for the current view and is sent to the model.
  - `currentEl.dataset.alert` is the alert on screen.
  - `historyEl` shows the last 4 earlier alerts.

## 6. Perceptron API facts (verified against docs.perceptron.inc and live calls, 2026-10-17)

- `POST https://api.perceptron.inc/v1/chat/completions`, OpenAI-compatible, `Authorization: Bearer $PERCEPTRON_API_KEY`. Model `perceptron-mk1.5`; Isaac models were retired on 2026-09-25.
- The output cap is **`max_completion_tokens`**. `max_tokens` is **not** in the schema; it was silently ignored when we used it.
- **`reasoning_effort`** can be `none`, `minimal`, `low`, `medium` or `high`. In our tests reasoning was off when the field was omitted; we send `none` explicitly. If reasoning is on, it streams separately as `delta.reasoning_content`, and that text uses up the `max_completion_tokens` budget.
- **Images:** `image_url.url` accepts https URLs and **base64 data URLs**. A 768 px frame costs about 730 prompt tokens with our prompt.
- **Video clips** (`video_frames`): at least 2 frames, each with `timestamp_ms` non-decreasing. **All frames must have identical dimensions**, otherwise the API returns 400 "all frame-backed video images must have the same dimensions".
- The `regex` parameter (constrained output) works but added 0.5–1 s and stopped the model from answering `n/a`. Not used.
- **Grounding:** `vision_config.annotation_format: "point" | "box" | "polygon"` returns markup inside the text with normalized 0–1000 coordinates. Not used yet; needed for the spatial map (section 10).
- **Stateless:** the API does not remember earlier requests or images. Every request carries all of its own context. Context window is 36,864 tokens; up to 256 media units per request; 20 MiB JSON body limit; 120 s time limit per request.
- **Rate limit:** 300 chat requests per minute per organization by default, across all keys. The app at 0.4 s intervals uses about 130–150 requests per minute; **don't run several phones on one key at a short interval**.
- Pricing: $0.15 per million input tokens and $1.50 per million output tokens. Per request (~730 input tokens): Off ≈ $0.00014 (~17 output tokens), Low ≈ $0.0004–0.0006, High ≈ $0.0025; Fast + Low pays for both. At the default 0.4 s interval (~140 requests/min, Off) that is **about $0.02 per minute**.
- **ElevenLabs cost (estimate, not measured on a bill):** API billing is per character of input text, not tokens. Third-party pricing pages (Oct 2026) list v4 Turbo at about **$0.04 per 1,000 characters** (some older pages say $0.05); confirm on elevenlabs.io/pricing. An alert is ≤ 12 words, about 60–80 characters plus the 10-character `[rapidly] ` tag. Speech takes ~2.5 s per alert, so continuous speech is at most ~24 alerts/min ≈ 1,800 characters ≈ **$0.07/min worst case**; a typical walk at ~6 alerts/min is ≈ 500 characters ≈ **$0.02/min**. Early-speech jobs the phone never claims are still billed. Total for both services: roughly **$0.04–0.09 per minute**.
- Docs index: `https://docs.perceptron.inc/llms.txt`. Every page is available as raw markdown by adding `.md`.

## 7. Decisions and the evidence behind them (don't undo without new data)

| Decision | Why (measured) |
|---|---|
| Up to 3 requests in flight, a new frame every 0.4 s | The model takes about 0.9 s per frame, and 3 concurrent requests took about as long as 1 (median 950 ms vs 893 ms). In a simulated walk, scene change → alert dropped from 1.5–1.7 s (one request at a time) to 0.7–1.5 s. |
| 768 px frames, not 512 | At 512 px the room sign "71A" was misread as "714" in 4 of 4 runs; at 768 px it was correct in 4 of 4. 512 px is only about 170 ms faster. |
| Single frame, not a 2-frame motion clip (`MOTION_FRAMES = false`) | With clips the model called a static scene "approaching" 3 of 3 times and misidentified cyclists as people walking. Single frames identified them correctly. The 2-frame request path still exists in code. |
| No streaming | Replies are a few words (about 0.1 s of streaming), and the whole reply is needed to filter repeats. |
| `temperature: 0.2` | Fewer rewordings of the same scene that would slip past the repeat filter. |
| Repeat filtering in the browser, not the server | With overlapping requests, only the browser knows the true latest `said`. |
| View-change reset at threshold 0.5 | Tuned on 24×18 thumbnails of 23 photos. Camera shake and exposure: 0 false resets out of 46. Different places detected: 240 of 253. Walking forward (20% zoom) resets about 25% of the time, which is acceptable because it re-announces the scene. |
| Softer "Already said" wording | The earlier wording ("never mention it again") made the model answer `n/a` to new places (a crosswalk after a stairs alert). The current wording says a different place is new and must be reported. |
| "List signs in one alert" rule | Without it, a sign listing rooms 71A, 71B, 71F and 71G produced 4 alerts in about 2 s. |
| Door rule ("say door only for an actual door…") | The user reported wide open spaces being called doorways. We couldn't reproduce it on stills (0 of 36 open-space answers said door), so this is a precaution. Real doors are still detected. |
| No distances except stair counts | User requirement. Measured adherence: 1 violation in 69 non-stair replies; stairs gave "at least N" 7 of 7 times. |
| Stairs: always up/down, with visual cues in the prompt | User requirement. Cues: going up shows the step fronts rising; going down shows step tops and edges dropping away. At temperature 0.2 on 6 stair photos (36 replies), direction was stated 36/36 and correct 30/36. All 6 errors were one side-on photo whose direction is hard to judge. |
| Stair count × 0.75 in code (`STAIR_COUNT_FACTOR`) | User wants underestimates. The model overcounts short flights consistently (5 for 2 gate steps, 10 for 8) and prompt wording didn't fix it. Overestimates went from 12/36 to 4/36; the remaining ones are on a 2-step flight. Long flights are already undercounted (15 for ~25). |
| Focus on center and foreground | User requirement. Old vs new prompt on 12 photos: dropped edge and distant details (a bike-lane sign at the edge, people far down a concourse, a building under construction behind a fence). Signs, doors and stairs straight ahead are still reported. |
| ElevenLabs `eleven_v4_turbo` for speech | The user asked for maximum realism and generation speed, with unlimited credits. Per ElevenLabs' model docs (Oct 2026), v4 Turbo is their most realistic real-time model at about 100 ms median inference. Flash v2.5 is about 75 ms but lower quality; Eleven v4 is the highest quality but not real-time. The earlier browser `speechSynthesis` version was removed because it lagged about 10 s behind. |
| **Safety-first prompt with hazard labels** (`prompt.js`): `Trip hazard:` · `Drop-off:` · `Head hazard:` · `Moving hazard:` · `Obstacle:`; no label for doors, signs or crosswalks | User request.
  - **Measured, old vs new prompt** (19 photos × 2 runs): hazard photos labelled 0/18 → 18/18; correct label overall 16/34 → 29/34; 0 replies over 12 words; median 609 → 639 ms.
  - **First version failed on stairs:** with only a stairs-down template, a stairs-up photo became "Drop-off: stairs going down". Fixed with one template per direction plus "direction decides the label": stairs up 5/6 and down 4/4 afterwards.
  - Examples are templates (`<object>, <where>`), because concrete examples get copied.
  - Regression: an aerial crosswalk photo and distant cyclists became `n/a`. |
| **Spoken questions (🎤 Ask, `POST /api/ask`)** | User request. Perceptron Mk1.5 takes audio, so one request carries the frame and the WAV question; no speech-to-text step.
  - The recording is encoded in the browser (`recorder.js`), because MediaRecorder formats aren't accepted.
  - **Measured through the server:** 14/14 correct after the prompt fixes (median 660 ms). The first prompt said "Yes, it appears safe" for stairs going up, so the ask prompt now forbids calling a path with stairs, curbs or obstacles safe ("No"/"Careful" plus the hazard).
  - Answers are urgent, not repeat-filtered, and not added to `said`.
  - **Auto-send** (user request: no second tap): `Recorder.createSpeechDetector` ends the question after `SILENCE_MS = 1200` of quiet once speech was heard (level > max(0.015, 3× noise floor) for 200 ms); no speech in 6 s ends the ask with nothing sent. While the button is held, auto-send is ignored and release sends. Trailing silence is trimmed to 300 ms. Thresholds are tuned on synthetic audio and ElevenLabs speech, **not yet in real street noise**.
  - Details in `docs/questions.md`. **iPhone audio routing after recording is unconfirmed.** |
| **Distance reading in AI requests** (`sensor`, `#sensorToAi`, `#sensorHeight`) | User request. The model is told the reading and mounting height, to confirm what in the **center** of the frame is close; never to say the number (the user hears beeps); to ignore a reading it can't see the cause of; and that the beam passes over curbs and steps.
  - **Measured** (real API, fake readings): 0 numbers spoken; latency unchanged; real close fence "close" 4/4 (1/2 without).
  - **Contradicting readings** (0.6 m on open views): the first wording invented "close" obstacles 9/12 (a car across the street); the final wording 1/12.
  - **Side effect:** the paragraph made the model label stairs going down "Trip hazard" 7/16 (0/8 without), so `filter.js` `fixStairLabel` now enforces the label from the direction, for all replies and answers.
  - Ground hazards: curb "close" 2/4 with vs 3/4 without; one missed pothole in 4. Watch on real walks; the toggle turns it off. |
| **Switchable prompt style** (`#safetyLabels`, `body.style`, `CLASSIC_PROMPT` in `prompt.js`) | User request: be able to go back to the pre-label responses. `CLASSIC_PROMPT` is the earlier prompt kept verbatim (checked equal to the saved copy). Default is safety. Fast + Low reasoning requests use the same style. |
| **Safety escalation + label-aware repeats** (`filter.js` `hazardLabel`, `isRepeat`) | Labels are stripped before comparing words; otherwise every "Trip hazard: …" shares "trip hazard" and different hazards look like repeats. A reply with a label the matching earlier alert lacked is new, for fast and Fast + Low replies ("Curb ahead" → "Trip hazard: curb close ahead"). Alerts that are all label and filler repeat only an equally bare alert with the same label; without this rule, "Trip hazard: step ahead." would be spoken every frame. 21 unit checks. |
| **Hazard speech priority** (`Speech.say(text, { urgent })`) | User request. A labelled alert stops a playing non-hazard clip and drops queued non-hazard clips; hazards never cut hazards. Uses per-clip cancellation (`dropNonUrgent`); the playback loop removes the clip it played by identity, since cut clips leave the queue. 8 checks with fake audio; the Interrupt setting still cuts everything. |
| **"Think briefly" for Low** (`BRIEF_REASONING` in `prompt.js`, added to the system prompt only when `reasoning === 'low'`) | Reasoning time comes from thinking tokens. Measured on 4 photos × 2 runs in one session:
  - Low as before: 2.1 s median, 6.9 s worst, ~330 tokens.
  - With the instruction: 1.35 s median, 3.0 s worst, ~170 tokens. Answers stayed correct (sign arrow still "right").
  - Rejected: a hard 400-token cap gave 2/8 empty answers. High ignores the instruction (~1,560 tokens regardless).
  - Through the server, 5 photos: 0.9–1.5 s typical, but outliers of 3.5 s and 6.2 s remain. |
| **"Fast + Low" mode** (`#reasoning` value `hybrid`) | User request: reasoning without waiting for it.
  - Each frame is sent twice: `reasoning: 'none'` (the normal path) and `'low'` via `sendSlow()`. Slow requests are tracked in `slowInFlight` (max `MAX_SLOW_IN_FLIGHT = 2`, outside `MAX_IN_FLIGHT`), staying under 300 requests/min.
  - `handleSlowReply()` uses its own `shownSlowSeq` ordering: newer fast replies always arrive first, so the fast `shownSeq` check would discard every slow reply. It ignores replies from an older view or older than `SLOW_MAX_AGE_MS = 4000`.
  - Slow replies are filtered with `Filter.classifyReply(reply, said, { refine: true })`. `refine` also treats a newly added direction word (left/right/up/down) as new, so "arrow right" after a fast "arrow left" is spoken as a correction. Identical restatements are still suppressed.
  - The 🐞 overlay shows the slow-reply time and counts: spoken, suppressed, too late.
  - Tests: 7 checks in the fake browser. |
| `Filter.viewChange` handles flat images | Found while testing hybrid mode: two featureless frames (black or blank: phone face down, covered lens, dark room) scored 1 ("unrelated") because a flat image has no pattern to compare. Every frame then became a new view, `said` was cleared each time, and the same alert repeated. Now two flat frames (std < ~3 grey levels) count as the same view unless their brightness differs by > 40; one flat and one not counts as different. Calibration on real photos is unchanged (same numbers at every threshold). |
| **Reasoning selector: Off / Low / High** (`#reasoning`, default Off, saved as `localStorage` `reasoning`; `body.reasoning` → `reasoning_effort` in `buildPayload`) | User request. Reasoning tokens count toward `max_completion_tokens`, so the cap is 40 when Off and `REASONING_BUDGET = 2048` for Low/High; 40 would leave an empty answer. With Low/High the request timeout is 30 s instead of 20 s.
  - Measured on 4 photos × 2 runs: Off 0.48 s median (0.62 max), ~17 output tokens; Low 1.3 s (4.4 max), ~320 tokens; High 4.9 s (5.4 max), ~1,560 tokens. No empty answers at 2048.
  - Through the server on the room-sign photo: Off 0.58 s, Low 1.38 s, High 6.0 s. Off read the arrow as "left"; Low and High read it correctly as "right". High also noticed cyclists in the crosswalk. |
| Early speech: start generating in `describe()` | Without it, generation only starts after the reply has gone to the phone and the phone has asked for audio, which costs one phone↔laptop round trip. Measured from the reply reaching the phone to its first audio byte, over 6–7 real alerts, with a simulated 150 ms hop each way: median 901 ms → 510 ms. With no network hop, no difference (328 vs 351 ms, noise). |
| Raw PCM streaming instead of MP3 | With MP3, the browser had to download and decode the whole clip before playing: about 0.7–0.9 s plus decode time. The PCM stream's first chunk arrives in about 0.2 s and is played at once. |
| `[rapidly]` tag for faster speech | v4 Turbo ignores `voice_settings.speed` but follows an audio tag, which isn't spoken (checked with `scribe_v2` transcripts). Measured on 3 alerts: no tag 10.16 s, `[speaking quickly]` 8.32 s, `[fast-paced]` 8.32 s, `[speaking very quickly]` 7.52 s, **`[rapidly]` 7.44 s**. Faster still but less natural: `ELEVENLABS_MODEL=eleven_flash_v2_5`, 6.46 s at speed 1.2. ElevenLabs rejects speeds above 1.2 (400 `invalid_voice_settings`). |
| Pause image sending while speaking (**"Pause while speaking" toggle**, `#pauseSpeaking`, default on, saved as `localStorage` `pauseWhileSpeaking`; variable `pauseWhileSpeaking` in `app.js`) | User request: each alert is heard in full before the app looks again; the user later asked for it to be switchable. `loop()` sends no frames while `Speech.pending > 0` and voice is on; requests already in flight still finish. Trade-off: nothing new is detected during speech, typically 2–3 s per alert. `speech.js` gives up on a download that receives nothing for `STALL_MS = 8000`, so a hung request can't pause the camera forever. |
| Speech queue: in order, nothing dropped, every clip generated as soon as it is queued | User requirement: no alert is lost. Generating ahead means the next clip is ready when the current one ends. Interrupt mode is opt-in. In queue mode, speech can fall behind if alerts come faster than they can be spoken; the voice chip shows how many are queued. |
| Web Audio API for playback, unlocked in the Start tap | iOS Safari only plays sound started from a user tap. One `AudioContext` resumed in the tap can play every later clip; new `<audio>` elements created later would be blocked. |
| Zero dependencies | Runs anywhere with Node 18+. No build step. |

## 8. Testing and verification

Everything is in `narrator/eval/`; the process, and how to read the output, is in **[`docs/testing-process.md`](docs/testing-process.md)**. To check a change:

1. **Offline checks (always):** `node narrator/eval/run.cjs`. Runs a syntax check, then 11 suites (~290 checks, ~1.5 min, no API calls): `filter.js`/`prompt.js` rules, the real `app.js`/`ui.js`/`speech.js`/`beeper.js`/`recorder.js`/`log.js` in fake browsers, and the real server's distance stream. Prints every check, a summary table, exits non-zero on any failure, and saves a transcript to `narrator/eval/results/`. `--list`, `--only <names>`, `--quiet`.
2. **Prompt evaluation (after changing `prompt.js` or `filter.js`; uses API credits):** `node narrator/eval/api_eval.cjs [--runs N] [--reasoning low] [--style classic]`. Sends 19 photos via `buildPayload` and filters replies via `classifyReply`, then checks ≤ 12 words, no distances, step counts only on stairs, the expected hazard label, and that the same view isn't spoken twice; reports median and worst latency. Results vary between runs: run before and after a change **in the same session** and compare. Baseline 2026-10-18: 84/88, median 1.08 s.
   - Run at most about 3 requests at once; 8 at once inflated latency to about 6 s.
   - Photos are Wikimedia Commons images in `narrator/eval/photos/` (gitignored, kept on disk). Several are top-down or aerial shots, which are poor tests for a pedestrian camera.
3. **Server smoke test:** `PORT=18080 HTTPS_PORT=18443 DISTANCE_PORT=15000 node narrator/server.js`, then curl `/api/describe` and check for a 200, a reply, and the `Server-Timing` header.
4. **Real device:** nothing replaces walking with a phone. Watch the latency chip. If the total is far above the model time, the delay is phone↔laptop networking.

New checks go in `narrator/eval/suites/` (one `✓`/`✗` line per check, `pass/total` last) and in `SUITES` in `run.cjs`. Keep one-off measurement scripts in `narrator/eval/experiments/` and list them in its README; don't leave them in a temporary folder.

## 9. Conventions for agents

- **Never commit `.env`, `certs/*.pem`, or API keys.** Never call Perceptron from browser code.
- Keep **zero npm dependencies** unless the team agrees otherwise.
- **Prompt changes go in `prompt.js` only.** Measure before and after on the test images. Keep the examples generic (the model copies them).
- `filter.js` must stay loadable in both the browser (`window.Filter`) and Node (`module.exports`).
- Accessibility first: one large Start button, an `aria-live` caption, nothing conveyed by color alone, phone-width layout with safe-area insets.
- Match the existing style: small functions, a comment explaining *why* for every tuning constant, no frameworks.
- Before claiming a change works, run the checks in section 8 and say what you couldn't test (e.g., there's no phone or headless browser here: no Chrome, no ffmpeg).

## 10. Known limitations

- **Latency floor:** the model takes about 0.8–1.8 s per frame. Scene change → alert is about 1–1.5 s at best.
- **Motion:** single frames can't tell whether something is approaching. "Approaching" claims are guesses based on context.
- **Ultra-wide lens:** only reachable when the browser exposes it, mainly iOS Safari. Most Android browsers expose neither the lens nor zoom below 1×. Ultra-wide also makes distant text smaller.
- **Stairs seen from the side** (not head-on) can get the wrong direction. Stair counts are rough: short flights are discounted in code, long flights come out low.
- **View-change detection:** about 5% of real place changes go unnoticed (similar-looking views). Walking forward sometimes triggers a reset, which re-announces the scene.
- **No memory beyond the current view's last 5 alerts.** Turning away and back re-announces things.
- **Rate limit** is shared across the organization: about 2 phones at the default interval on one key.

## 11. Plan: spatial map (next major feature, not started)

**Goal:** an app-side, short-term map (roughly the last 60 s or 20 m) of where things are relative to the walker. It would enable "stairs behind you, left", "the door you passed is on your right", and alerts when turning toward a known hazard. It would also replace text-based repeat filtering with position-based identity, so turning away and back doesn't re-announce, and a second door further on still counts as new. Perceptron is stateless, so all memory lives in the app.

**Inputs**
1. **Heading:** `webkitCompassHeading` (iOS; needs `DeviceOrientationEvent.requestPermission()` from a user tap such as Start) or the `deviceorientationabsolute` event (Android). Tilt (`beta`) comes from the same sensor.
2. **Object position in frame:** request `vision_config.annotation_format: "point"`, so each mentioned object comes with normalized 0–1000 coordinates in the reply markup. World bearing = `heading + (x/1000 − 0.5) × horizontalFOV`. Example: heading 0°, x = 800, field of view 70° → about 21° right.
3. **Distance (rough):** for objects on the ground, the angle below the horizon from y, phone tilt and an assumed camera height of about 1.3 m gives `distance ≈ h / tan(angle)`. Expect ±30–50%.
4. **Walker movement:** step detection from `devicemotion` acceleration peaks, at about 0.7 m per step along the heading.

**Map model:** landmarks `{label, x, y, lastSeen, seenCount}` in a frame anchored where the walker started. A new observation merges into an existing landmark with the same label within about 2 m; otherwise it's added. Entries expire after about 60 s or about 20 m walked, because errors grow.

**Error budget:** indoor compass error is 10–30° (metal and electronics); step counting drifts 5–10% of distance; model distances are rough. So this is a short-term memory, not a floor plan.

**Android upgrade:** WebXR with ARCore in Chrome on Android gives camera-tracked 6-DoF pose and hit-testing on real surfaces, with positions accurate to tens of centimetres and no compass or step drift. iOS Safari has no WebXR, so iPhones keep the compass-and-steps version.

**Build order**
1. **Measure first:** add `annotation_format: "point"` on the test images. Check that latency stays near 1 s and points land on the right objects, and parse the markup format. If point output is slow, request points in a separate, less frequent request.
2. **Heading-only:** compass plus point x gives a bearing per object, with no distance or steps. Enough for "behind you / left / right" and position-based repeat suppression.
3. Add distance from tilt, and step detection.
4. Optional: WebXR path for Android.

## 12. Open questions for the team

- Is the earlier Next.js/Vercel plan dropped for good? The current recommendation is to stay on plain Node + HTML/JS (reasons in `docs/architecture.md`, "Why not a bigger web stack").
- Speech in queue mode can fall behind during busy stretches. (Hazards now cut in ahead of other speech. Is that enough, or should the queue also be capped?)
- Where will this be deployed for the demo? Hosting needs real HTTPS plus the API key kept server-side.
