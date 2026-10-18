# Testing and measurement

There is no phone or headless browser on the development laptop (no Chrome, no ffmpeg). Testing combined:
- **real API calls** (Perceptron, ElevenLabs) through the real server
- **simulated browsers in Node:** the real `app.js`, `speech.js`, `beeper.js` and `ui.js` run against fake camera, audio, screen and DOM objects
- **photo-based calibration** for the vision thresholds

**Important:** the test scripts were written in a temporary scratch folder and are **not in the repo**. Recreating them under `narrator/eval/` (with photos downloaded on demand, not committed) is a recommended next step. What each one checks is described below, so they can be rebuilt.

## Suites and what they cover

| Suite (scratch name) | Runs | Checks | Covers |
|---|---|---|---|
| `orient_test.cjs` | real `app.js` in a fake browser | 73 | camera reopen races; Stop while opening; 180° turns (events + polling); fullscreen lock/re-lock/unlock; the 🐞 overlay; Android flip correction (preview + AI frames, hysteresis, not on iPhone); pause while speaking (on/off); beeper wiring; blur gate (skip, 100 ms retry, 2 s fallback, gyroscope, spoken hint once per 15 s, not with Voice off); reasoning selector (default, saved, restored, request body); Fast + Low (two requests per frame, ≤2 slow in flight, correction spoken, duplicate suppressed, old view ignored) |
| `ui_test.cjs` | real `ui.js` in a fake DOM | 13 | sheet open/close (⚙, ✕, backdrop, Escape) and focus; segmented control ↔ select; tap / Enter to repeat; hazard highlight; vibration once per new alert; no vibration support |
| `queue_test2.cjs` | real `speech.js` with fake fetch streams and a fake Web Audio clock | 12 | audio starts on the first chunk; in-order playback with no overlap or loss; next clip starts as soon as the previous ends; odd byte splits; interrupt; retry; cancel; voice off |
| `stall_test.cjs` | real `speech.js` | 1 | a hung download is given up and the queue drains |
| `beeper_test.cjs` | real `beeper.js` | 20 | curve shape and formulas; intensity; beat spacing; immediate speed-up; ducking (not at ≤10 cm); stale/offline; replayed old reading; out of range; toggle; stop; volume |
| `sse_test.cjs` | real `server.js` over HTTP | 11 | ESP-style POSTs → 204; delivery to the stream < 50 ms; out of range; bad bodies → 400; latest reading on connect; 10 readings in order |
| filter/prompt checks | `filter.js`, `prompt.js` in Node | ~20 | repeat rules (stairs up vs down, recount, close, room numbers, `refine` directions); stair-count discount; `n/a`; `buildPayload` reasoning levels, caps, brief-thinking instruction |
| ESP health scenarios | `server.js` + `curl` | 3 scenarios | Wi-Fi drop vs reboot vs old sketch, as logged |

## Real-API measurements (method)

- **Send exactly what the server sends:** build requests with `require('./narrator/prompt').buildPayload(...)`, and filter replies with `filter.js`.
- **Concurrency:** at most ~3 requests at once. 8 at once inflated latency to ~6 s and distorted results.
- **Compare like with like:** run variants in the **same session**, because Perceptron latency varies between sessions (Low measured 1.3 s median one time, 2.1 s another). Use medians over several runs, and note the worst case.
- **Through the server:** start it on spare ports (`PORT=18080 HTTPS_PORT=18443 DISTANCE_PORT=15000 node server.js`) so it doesn't clash with a running instance. Read `Server-Timing` for model time.
- **Simulated walk:** a script feeds 5–6 scene photos for 5 s each at the app's real scheduling, and records the time from each scene change to its alert.
- **Speech:** first-byte and total times, clip length from PCM byte counts. ElevenLabs speech-to-text (`scribe_v2`) confirmed delivery tags aren't spoken.

## Test photos and calibration

- Photos from Wikimedia Commons:
  - stairs up and down (incl. a side-on view)
  - a curb, a crosswalk, a pothole
  - building and room signs ("Bella Concert Hall", "Class Room 71A/71B/71F/71G")
  - a corridor, an atrium, a concourse, a mall, a plaza, a library, an archway, a parking lot, several doors
- Resized with `sips -Z 768`. Thumbnails made with `sips -z <h> <w> -s format bmp` and parsed as BMP in Node. Some are top-down or aerial shots, which are poor stand-ins for a walking camera.
- **View-change threshold:** 24×18 thumbnails, with simulated shake (offset crops), exposure changes and walking forward (20% zoom). 0.5 gave 0/46 false resets and 240/253 changes detected.
- **Blur threshold:** 160×120 copies with synthetic blur (box, 3/5/9 px horizontal motion), shake and brightness changes. 0.5× gave 0/29 false skips.
- **Prompt changes:** old vs new prompt on the same photos, side by side.

## Known gaps: needs a real phone

- Real camera motion blur and low-light noise (blur thresholds).
- The Android flip tipping point (the overlay logs it).
- Ultra-wide lens selection, fullscreen/portrait lock behaviour across browsers.
- Listening to speech and beeps; the swipe-to-close gesture; vibration.
- Phone ↔ laptop network delay (the overlay shows total vs model time).
- ESP8266 power stability on battery.

## Quick checks before committing

```sh
node --check narrator/server.js narrator/prompt.js narrator/public/*.js
node -e "const F=require('./narrator/public/filter.js'); console.log(F.classifyReply('Stairs up ahead, at least 5 steps.',['Stairs down ahead, at least 10 steps.']).reason)"   # new
PORT=18080 HTTPS_PORT=18443 DISTANCE_PORT=15000 node narrator/server.js   # then curl the endpoints
```
