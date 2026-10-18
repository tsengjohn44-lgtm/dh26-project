# AGENTS.md: Live Scene Narrator (DubHacks '26)

Guide for AI coding agents working in this repo. It describes the code as it exists and the plan for what comes next. `CLAUDE.md` only imports this file, so every agent reads the same guide.

> **Stack note.** An earlier plan for this project used Next.js/TypeScript on Vercel, Grok text-to-speech, and "rough distances" in speech. **That is not what was built**: the code is a zero-dependency Node server plus static HTML/JS in `narrator/`, with no speech output. Distances were deliberately removed, except stair counts. Don't start a Next.js migration or add text-to-speech without asking the team; both were dropped on purpose (see "Decisions").

---

## 1. What the app does

A phone web page that streams the rear camera to the **Perceptron Mk1.5** vision-language API. It shows very short, navigation-focused alerts for a **blind pedestrian**:

- **Hazards** (top priority): things approaching fast, stairs, curbs, drop-offs, potholes, uneven ground, obstacles at foot, body or head height.
- **Navigation cues:** doors, crosswalks, intersections, elevators, turns.
- **Large readable text:** building names, room names and numbers, major signs, quoted exactly.

Rules for the output:
- At most 12 words, on one line.
- Positions are only **left, ahead or right**, plus **"close"** for anything within about 2 steps.
- **No distances or step counts**, except stairs, which always get an estimated minimum: "Stairs down ahead, at least 8 steps."
- If nothing new and important is visible, the model replies **`n/a`**. The app then shows nothing new.
- The app must **not repeat** what it has already said about the current view.

There is no speech output. Text-to-speech was built and then removed at the user's request. The UI is a large high-contrast caption with an `aria-live` region.

## 2. Run it

```sh
cd narrator
echo 'PERCEPTRON_API_KEY=...' > .env      # gitignored; get a key at https://platform.perceptron.inc/
node server.js                            # Node >= 18, no npm install
```

- Desktop: `http://localhost:8080`. A webcam works, since localhost counts as a secure context.
- Phone (same Wi-Fi): `https://<lan-ip>:8443`. The server creates a self-signed certificate in `narrator/certs/` (gitignored) and prints the URL. Tap through the certificate warning.
  - Phones only allow camera access over HTTPS.
  - The certificate is tied to the LAN IP at the time it was made. If the IP changes, delete `narrator/certs/` and restart.
- Off-Wi-Fi alternative: `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`.
- Environment variables: `PERCEPTRON_API_KEY` (required), `PERCEPTRON_MODEL` (default `perceptron-mk1.5`), `PORT` (8080), `HTTPS_PORT` (8443).
- After changing files under `public/`, hard-refresh the phone. After changing `server.js` or `prompt.js`, restart the server.

## 3. Repo map

```
AGENTS.md            this file: the guide for all AI agents
CLAUDE.md            one line, "@AGENTS.md", so Claude Code loads this file
README.md            repo credits (.claude/ agents and skills come from ECC, MIT)
.claude/             shared agent definitions and skills (code-reviewer, build-error-resolver, …)
narrator/
  server.js          static file server + POST /api/describe proxy to Perceptron; HTTP 8080 and HTTPS 8443
  prompt.js          SYSTEM_PROMPT + buildPayload(): the exact request sent to Perceptron
  README.md          user-facing run/usage notes
  .env               PERCEPTRON_API_KEY (gitignored, never commit)
  certs/             auto-generated self-signed TLS cert (gitignored)
  public/
    index.html       UI shell: video, status chips, caption, history, Start button, interval slider
    style.css        dark, high-contrast, phone-first layout (safe-area insets)
    app.js           camera, frame capture, request scheduler, view-change detection, UI updates
    filter.js        shared by browser and Node: n/a and repeat filtering, viewChange()
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
  - The server does **no filtering**. All "is this worth showing" logic lives in the browser, because only the browser knows what is currently on screen while several requests are in flight.

### `narrator/prompt.js`
- `SYSTEM_PROMPT` is the single source of truth for model behavior. Sections: role, report priorities, "Be certain" (the door rule), style, the "Already said" rule, `n/a`, and examples.
- `buildPayload(body, model)`:
  - `body = { image, said?, prevImage?, prevDtMs? }`.
  - It sends one `image_url`, or a 2-frame `video_frames` clip when `prevImage` is given; clip mode is currently unused, see `MOTION_FRAMES`.
  - The user text lists "Already said (oldest first)".
  - Settings: `stream: false`, `reasoning_effort: 'none'`, `temperature: 0.2`, `max_completion_tokens: 40`.
- The prompt examples are copied almost word for word by the model. Keep them generic. An example once said "Curb close ahead, crosswalk beyond it", and the model then added "crosswalk beyond it" to a photo with no crosswalk.

### `narrator/public/filter.js` (UMD: `window.Filter` in the browser, `require()` in Node)
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
- Pricing: $0.15 per million input tokens and $1.50 per million output tokens, roughly $0.01 per minute of use.
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
| No text-to-speech | Removed at the user's request. (It also lagged badly: about 10 s per utterance against about 1.3 s per description.) |
| Zero dependencies | Runs anywhere with Node 18+. No build step. |
| On-device detector is opt-in (`?detector=1`): MediaPipe EfficientDet-Lite0 float16 on GPU, from pinned CDN URLs | iPhone Safari (iOS 26.6.1): 52 ms/frame median, 72 ms p90, about 19 fps. Lite2 float16 on GPU never finished loading there. Laptop (in-app Chromium, Intel Mac): Lite0 f16 GPU 24 ms, Lite2 f16 GPU 41 ms, CPU 57 ms. The int8 models returned no detections at all on GPU, so GPU uses float16. Apache-2.0; still no npm dependency (11.2 MB wasm + 6.9 MB model download only when the flag is on). Falls back to Lite0 int8 on CPU if the GPU model hasn't loaded in 20 s. (2026-10-17) |
| Detector's people and objects go in the caption after Perceptron's alert, not in a separate line | The prompt reports people only as hazards: two people at a table got `n/a` 6 of 6 times, with or without a hint, while the detector named both ("Person on the left, person ahead."). The user asked for one caption. |
| Detector hints to Perceptron off by default (`&hints=1`) | `eval/hints.html`, 11 photos, 26 calls per mode: model time 514 ms without vs 541 ms with the hint, and no new counts. A planted wrong hint ("Dog close ahead.") showed up in 2 of 26 replies. |
| Detector classes exclude "bench"; minimum score 0.5 | In upright (portrait) frames Lite0 called stairs a bench (0.57) and crosswalk stripes a bench (0.88). Other false detections scored 0.39–0.46; real people 0.77–0.87, nearby cars 0.6 and up. |
| Detector loop on a 15 fps timer, not `requestVideoFrameCallback` | Frame callbacks dropped to about 1.5/s whenever the window wasn't being painted; timers kept running at about 38/s. |
| Scene change → detector caption in about 0.55 s | 10 trials on the laptop with a fake camera (hallway → cyclist): detector text median 555 ms (489–576) vs Perceptron's alert 716 ms (452–1,237). Most of the 555 ms is the 300 ms hold in `tracker.js` (`STABLE_MS`) plus 2 frames to confirm an object. Not yet measured on a phone. |

## 8. Testing and verification

There is no automated test suite in the repo yet. The evaluation scripts used so far lived outside the repo. To check a change:

1. **Syntax:** `node --check narrator/server.js narrator/public/app.js narrator/public/filter.js && node -e "require('./narrator/prompt')"`
2. **Filter unit checks** (no API calls):
   ```sh
   node -e "const F=require('./narrator/public/filter.js'); console.log(F.classifyReply('Stairs up ahead, at least 5 steps.',['Stairs down ahead, at least 10 steps.']))"   # expect reason 'new'
   ```
   Cases that must hold:
   - same stairs with a different count → `repeat`
   - stairs became "close" → new
   - Room 214 → Room 215 → new
   - "Curb ahead." after "Curb ahead, crosswalk beyond it." → `repeat`
   - `n/a` → `n/a`
3. **Server smoke test:** run with `PORT=18080 HTTPS_PORT=18443 node server.js` (avoids clashing with a running instance), then `curl -X POST localhost:18080/api/describe -H 'Content-Type: application/json' -d '{"image":"data:image/jpeg;base64,…","said":[]}'`. Check for a 200, a reply, and the `Server-Timing` header.
4. **Prompt evaluation** (uses API credits). Build the request with `require('./narrator/prompt').buildPayload(...)`, so tests send exactly what the server sends. Filter replies with `filter.js`. Check:
   - each test image produces an alert of 12 words or fewer
   - the same image with its own alert in `said` → `n/a` or `repeat`
   - a different image after an unrelated alert → a new alert
   - no step counts except on stairs
   - door mentions on open-space images
   - latency (median and max)
   - Run at most about 3 requests at once; 8 at once inflated latency to about 6 s.
   - Test photos so far: Wikimedia Commons (stairs, curb, crosswalk, pothole, building sign "Bella Concert Hall", room sign "Class Room 71A/71B/71F/71G", corridor, cyclists, atrium, concourse, mall, plaza, library, archway, parking lot, several doors). Resize them to 768 px with `sips -Z 768`. Several are top-down or aerial shots, which are poor tests for a pedestrian camera.
5. **Real device:** nothing replaces walking with a phone. Watch the latency chip. If the total is far above the model time, the delay is phone↔laptop networking.

If you add a proper harness, put it in `narrator/eval/` and keep images out of git, or download them on demand.

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

- Is the earlier Next.js/Vercel plan dropped for good, or is a migration of `narrator/` still wanted?
- Should speech come back in a form that keeps up? For example: speak only hazards, cancel stale speech, and keep utterances under about 3 s.
- Where will this be deployed for the demo? Hosting needs real HTTPS plus the API key kept server-side.
