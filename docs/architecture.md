# Architecture

## What runs where

```
┌────────────────────────── Phone (browser) ───────────────────────────┐
│ index.html · style.css · ui.js        screen, settings, tap-to-repeat │
│ app.js     camera, blur gate, view change, request scheduler, replies │
│ filter.js  n/a + repeat filtering, sharpness, view-change measure     │
│ speech.js  ElevenLabs audio queue, streaming playback (Web Audio)     │
│ beeper.js  proximity beeps from the distance sensor                   │
└───────────────┬───────────────────────────────────────▲──────────────┘
                │ HTTPS :8443 (self-signed)  or  HTTP :8080 (localhost)│
┌───────────────▼────────────── Laptop: narrator/server.js ────────────┴┐
│ static files · POST /api/describe · POST /api/speak                   │
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
2. **Describe** (`POST /api/describe`): the phone sends the frame, the alerts already said for this view (up to 5), and the reasoning level.
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
| `beeper.js` | the latest distance reading and its time |
| `server.js` | the latest distance reading, the ESP health summary, early speech jobs (15 s) |
| `localStorage` (phone) | settings: voice, interrupt, pauseWhileSpeaking, reasoning, beeps, beepVolume, beepIntensity, debug |

Perceptron is **stateless**: every request carries its own context. Nothing is remembered between requests except what the app sends.

## Design rules

- Short alerts (≤12 words), positions only (left/ahead/right/"close"), no distances except stair counts.
- Measure before changing behaviour. Every tuning constant has a comment saying why it has that value ([testing.md](testing.md)).
- If something optional fails, the core still works: no ElevenLabs key means silent text, no sensor means no beeps, and if `ui.js` fails the controls still work as plain form controls.
