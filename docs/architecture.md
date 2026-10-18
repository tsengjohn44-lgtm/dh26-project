# Architecture

## What runs where

```
┌────────────────────────── Phone (browser) ───────────────────────────┐
│ index.html · style.css · ui.js        screen, settings, tap-to-repeat │
│ app.js     camera, blur gate, view change, request scheduler, replies │
│ filter.js  n/a + repeat filtering, sharpness, view-change measure     │
│ log.js     history of every reply, kept on the phone (🕘 History)     │
│ speech.js  ElevenLabs audio queue, streaming playback (Web Audio)     │
│ beeper.js  proximity beeps + latest valid reading for the AI requests │
│ recorder.js microphone → 16 kHz WAV for spoken questions (🎤 Ask)     │
└───────────────┬───────────────────────────────────────▲──────────────┘
                │ HTTPS :8443 (self-signed)  or  HTTP :8080 (localhost)│
┌───────────────▼────────────── Laptop: narrator/server.js ────────────┴┐
│ static files · POST /api/describe · POST /api/ask · POST /api/speak   │
│ POST /distance · GET /api/distance/stream (SSE)                       │
│ prompt.js builds the Perceptron request · early speech jobs           │
│ API keys live only here (.env)                                        │
└───────┬───────────────────────────┬───────────────────────────▲───────┘
        │ HTTPS                     │ HTTPS                     │ HTTP :5000 (or :8080)
┌───────▼────────┐        ┌─────────▼─────────┐        ┌────────┴────────┐
│ Perceptron     │        │ ElevenLabs        │        │ ESP8266 +        │
│ perceptron-    │        │ eleven_v4_turbo   │        │ ultrasonic sensor│
│ mk1.5          │        │ streaming PCM     │        │ (esp8266_main.ino)│
└────────────────┘        └───────────────────┘        └─────────────────┘
```

- **Zero dependencies:** Node 18+ built-ins on the server, plain HTML, CSS and JS on the phone. No build step.
- **Keys never reach the phone:** the browser only talks to `server.js`, which adds the Perceptron and ElevenLabs keys.
- **The phone decides what to show.** With several requests in flight, only the phone knows what is currently on screen and what has been said, so all "is this new?" logic lives in the browser (`filter.js`). The server runs the same filter once, only to start speech early (see [speech.md](speech.md)).

## One alert, end to end

1. **Capture** (`app.js` `pickFrame`): every 0.4 s (Settings → Frame every), while fewer than 3 requests are open and nothing is being spoken:
   - draw the camera frame at ≤768 px, turned upright if Android flipped it
   - score its sharpness; if blurry, skip and look again in 100 ms
   - compare a 24×18 thumbnail with the current view; a big change starts a **new view**, which clears what has been "already said"
2. **Describe** (`POST /api/describe`): the phone sends the frame, the alerts already said for this view (up to 5), the reasoning level, the prompt style and, if Settings → Share distance with AI is on and the sensor has a valid reading, `sensor: { distanceM, heightM }`.
   - The server builds the Perceptron request (`prompt.js`) and returns the model's text with `Server-Timing`.
   - **In parallel:** if the reply is a new alert, the server starts generating its speech straight away.
3. **Filter** (`filter.js` `classifyReply`):
   - drop `n/a` and near-repeats
   - scale stair counts down (×0.75, cautious)
   - in Fast + Low mode, the slower reasoning reply is shown only if it adds or corrects something
4. **Show** (`showAlert`): the alert goes into the card, the previous one into history, and `ui.js` adds the hazard edge and a vibration.
5. **Speak** (`speech.js`):
   - `POST /api/speak` picks up the early job or starts one
   - audio streams back as raw PCM and plays as it arrives, queued behind earlier alerts (or cutting in, with Interrupt on)
6. **Beeps:** independently, sensor readings arrive by push (`/api/distance/stream`), and `beeper.js` beeps faster and louder as obstacles get closer, ducking under the voice.

Typical timings without reasoning: model ~0.5–0.9 s; scene change → alert ~0.7–1.5 s; reply → first audio ~0.2–0.5 s. Details in [optimization.md](optimization.md).

## Ports and addresses

| Port | Who uses it | Notes |
|---|---|---|
| 8080 HTTP | desktop browser on the laptop; ESP8266 fallback | localhost counts as secure, so the camera works |
| 8443 HTTPS | phones | self-signed certificate made by `openssl` on first run; includes `<mac>.local` and the LAN IPs |
| 5000 HTTP | ESP8266 (`DISTANCE_PORT`) | on macOS usually taken by AirPlay Receiver; the server says so, and `/distance` also works on 8080 |

Phones can open `https://<mac-name>.local:8443` (e.g. `https://NoozMBP.local:8443`), which keeps working when the laptop's IP changes. That needs Android 12+ or an iPhone, and a network that allows local names (some campus networks block them).

## State the app keeps

| Where | What |
|---|---|
| `app.js` | `said` (last ≤5 alerts of the current view), `viewId` and `viewThumb`, request sequence numbers, blur history, flip-correction state |
| `speech.js` | the audio queue, with each clip's chunks as they arrive |
| `beeper.js` | the latest distance reading and its time (`Beeper.reading` gives it to `app.js` only when valid and fresh) |
| `recorder.js` | microphone samples while a question is being recorded, and the end-of-speech detector |
| `log.js` | the last 1,000 replies and what was done with each (shown, repeat, n/a, late, error), saved to `localStorage` |
| `server.js` | the latest distance reading, the ESP health summary, early speech jobs (15 s) |
| `localStorage` (phone) | settings: voice, interrupt, pauseWhileSpeaking, safetyLabels, reasoning, beeps, beepVolume, beepIntensity, sensorToAi, sensorHeight, debug, logFilter; the reply history (`replyLog`) |

Perceptron is **stateless**: every request carries its own context. Nothing is remembered between requests except what the app sends. The server keeps no record of replies; the only history is on the phone (`log.js`).

## Design rules

- Short alerts (≤12 words), positions only (left/ahead/right/"close"), no distances except stair counts.
- Measure before changing behaviour. Every tuning constant has a comment saying why it has that value ([testing.md](testing.md)).
- If something optional fails, the core still works: no ElevenLabs key means silent text, no sensor means no beeps, and if `ui.js` fails the controls still work as plain form controls.

## Design decisions (system level)

Each system doc has its own "Design decisions" section; these are the ones that shape the whole system.

| Decision | Why | Rejected alternative |
|---|---|---|
| **A laptop server between the phone and the APIs** | The Perceptron and ElevenLabs keys must never reach the phone, where anyone can read page code. The server is also the only place the ESP8266 can post to, and it can start speech early (it sees the model's reply before the phone does). | Calling the APIs from the browser: exposes the keys. |
| **The phone decides what is new; the server only proxies** | Up to 3 requests are in flight at once and replies can arrive out of order. Only the phone knows which alert is on screen and what has been said for the current view, so the repeat filter, view tracking and reply ordering live in `app.js`/`filter.js`. The server runs the same `filter.js` only to *guess* early, for speech; a wrong guess just wastes one speech job. | Filtering on the server: it would need the phone's live state, and get races wrong. |
| **One shared filter file for browser and Node** (`filter.js`, UMD) | The server's early-speech guess must match the phone's decision exactly, or early jobs go unused. One file guarantees it, and lets the filter be unit-tested in Node. | Two copies: they drift. |
| **Short-term memory lives in the app, not the model** | Perceptron is stateless. The app sends only the last ≤5 alerts of the *current view*: enough to stop repeats, small enough to keep requests fast (images dominate the cost: ~730 tokens vs ~45 ms for the whole prompt). | Sending long history: slower and makes the model reluctant to report new places. |
| **Push, not polling, for the sensor** (SSE) | A reading reaches the phone in < 50 ms and costs nothing when idle; polling at 5 Hz would add up to 200 ms delay and constant requests. | Polling `/api/distance` from the phone. |
| **One `AudioContext`, unlocked in the Start tap** | iOS only plays sound started from a tap. One context resumed there serves speech, beeps and the microphone for the whole session. | `<audio>` elements per clip: blocked on iOS after the first tap. |
| **Optional parts fail soft** | A demo must survive missing pieces: no ElevenLabs key → text only; no sensor → no beeps and no distance in requests; `ui.js` fails → plain form controls still work; no microphone → Ask says so. | Hard dependencies between features. |
| **Measure, then decide** | Every tuning constant (blur ratio, view-change threshold, stair factor, silence time, prompt wording) was set from measurements on real APIs or photos, and the code comments say which. Several "obvious" ideas measured worse and were dropped (see [optimization.md](optimization.md), "Tried and rejected"). | Tuning by feel. |

## Why not a bigger web stack (React, Next.js, TypeScript build, serverless)

Considered on 2026-10-18 when the team asked whether to migrate. **Decision: stay on plain Node + static HTML/JS for now**, and make targeted upgrades instead.

**Why a framework doesn't help here:**
- **The hard parts aren't what frameworks solve.** The difficult code is the camera (lens choice, Android flip correction, orientation lock), Web Audio (streamed PCM playback, scheduling, ducking), the microphone, sensors, and timing-sensitive request pipelining. React or Next.js add nothing there. React's re-rendering can even get in the way of the camera and audio loops, which hold imperative, long-lived state (`AudioContext`, media streams, timers).
- **The interface is small:** one screen and one settings sheet. A framework's strengths (many screens, shared components, routing, data fetching) don't apply.
- **A rewrite risks measured behaviour.** About 3,000 lines encode behaviour that took measurement to get right: blur gate, flip correction, speech queue and priority, early speech, Fast + Low, auto-send. A port would have to re-verify all of it, which is hackathon time better spent testing on phones.
- **Serverless hosting (e.g. Vercel) fits poorly.** The app needs long-lived streaming responses (PCM audio, SSE for the sensor), in-memory state shared between requests (early speech jobs, the latest sensor reading), and a plain-HTTP endpoint for the ESP8266. Serverless functions are short-lived and stateless, so all three would need workarounds (external queues or stores).
- **Zero dependencies is a feature:** `node server.js` runs on any laptop with Node 18+, with no install or build step. That matters at a hackathon and for teammates' AI agents editing the code.

**What would justify a migration later:**
- several people working on the UI at once
- many screens or user accounts
- a **native app**: React Native or Swift/Kotlin would give reliable camera control, background audio and a true portrait lock without browser workarounds. That, not a web framework, is the real next step if the browser's limits start to bite.

**Cheaper upgrades that give most of the benefit** (not done yet):
1. ~~**Put the tests in the repo**~~ Done 2026-10-18: `narrator/eval/`, one `node narrator/eval/run.cjs` ([testing-process.md](testing-process.md)).
2. **Split `app.js` into native ES modules** (`<script type="module">`, still no build): camera, frames, requests, ask, settings.
3. **Type checking without a build:** JSDoc types + `// @ts-check`, checked by `npx tsc --noEmit --allowJs --checkJs` (TypeScript as a dev-only tool).
4. **Installable web app + real hosting:** a `manifest.json` (`display: fullscreen`, `orientation: portrait`) to lock portrait without the fullscreen API, and the server on a small VM with real HTTPS, so there are no certificate warnings and no laptop is needed.

If a framework is still wanted after those, plain TypeScript with Vite (still no React) is the next step up, not Next.js.
