# Live Scene Narrator

A phone web app that streams the camera to the [Perceptron](https://docs.perceptron.inc) vision-language API (`perceptron-mk1.5`) and shows a live description of your surroundings.

## Run

```sh
cd narrator
echo 'PERCEPTRON_API_KEY=your_key_here' > .env   # or export it
echo 'ELEVENLABS_API_KEY=your_key_here' >> .env  # optional: spoken alerts
node server.js
```

The app needs Node 18 or later and has no npm dependencies. On startup the server prints:

- `http://localhost:8080`, for a laptop with a webcam
- `https://<your-lan-ip>:8443`, to open on a phone on the same Wi-Fi

Phones only allow camera access on HTTPS pages, so the server creates a self-signed certificate in `certs/` the first time it runs. When the phone shows a certificate warning, tap through it: **Show details → visit website** on iOS, **Advanced → Proceed** on Android.

To get a real HTTPS URL instead, which also works off your Wi-Fi, run a tunnel to port 8080, for example `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`.

## Use

- **Main screen:**
  - a status pill at the top (Live / paused / hold steady, plus the sensor distance)
  - the current alert in a large card. Hazards get an amber edge, and Android phones vibrate on each new alert.
  - **tap the card to hear it again**
  - the last two alerts below it
- **Bottom bar:** **Voice** on/off · **Start/Stop** · **Beeps** on/off.
- **⚙ Settings** (swipe down or tap outside to close):
  - **Speech:** Interrupt, Pause while speaking
  - **Vision:** Reasoning (Off · Fast+Low · Low · High), Frame every
  - **Proximity sensor:** Beep volume, Intensity
  - **Diagnostics:** the overlay with timing, camera, blur and sensor details
- The app always uses the **widest rear camera** (see Start / Stop). **⇄** (switch to the front camera) only shows with the Diagnostics overlay on.

Details of each setting:

- **Start / Stop**: opens the rear camera and begins narrating. The app uses the widest view it can get: the ultra-wide lens when the browser offers it (iOS Safari lists it as "Back Ultra Wide Camera"), otherwise the lowest zoom, at 4:3 so the full sensor is used. The top bar shows which camera is in use.
- **Voice**: speaks each new alert with ElevenLabs (`eleven_v4_turbo`). Audio is streamed, and the server starts generating it as soon as Perceptron replies, before the alert reaches the phone. A `[rapidly]` delivery instruction makes speech about 27% faster than plain. While an alert is being spoken, no new images are sent to Perceptron. By default alerts are queued and spoken in order, with none skipped. The top bar shows how quickly speech started and how many clips are waiting. Requires `ELEVENLABS_API_KEY`; set `ELEVENLABS_VOICE_ID` to use a different voice. For even faster but less natural speech, set `ELEVENLABS_MODEL=eleven_flash_v2_5`; it speaks at `ELEVENLABS_SPEED`, default 1.2.
- **Phones** go fullscreen and lock to portrait on Start. This stops the screen from turning over when you tilt the phone, which made the camera image upside down on Android.
- **Reasoning** (Off / Fast + Low / Low / High): **Fast + Low** gives the normal fast alert, then a reasoning check about a second later that speaks only if it adds or corrects something (e.g. a sign's arrow direction). Otherwise: lets Perceptron think before answering. Low reads details more accurately (e.g. a sign's arrow direction) but takes about 1.3 s per frame instead of 0.5 s; High is the most thorough, at about 5 s. Off is best for walking.
- **Safety labels** (Settings → Vision, on by default): turn off to get the earlier plain style ("Curb close ahead.") instead of "Trip hazard: curb close ahead."
- **Hazard alerts** start with a label (Trip hazard, Drop-off, Head hazard, Moving hazard, Obstacle) and are spoken first: they cut off a sign or door being read, and skip ahead of anything queued.
- **Pause while speaking** (on by default): no new images are sent to Perceptron while an alert is being spoken, so you hear each one in full. Turn it off to keep looking while the voice talks (new alerts then queue up or, with Interrupt on, cut in).
- **Interrupt**: when on, a new alert cuts off the one being spoken and skips anything queued, so you always hear the latest.
- **Blurry frames are skipped**: if the camera image is blurry (moving, swinging, out of focus), it isn't sent to Perceptron until a sharp one comes along. After 2 s it sends the sharpest frame anyway. If it stays blurry for 3 s, the voice says "Hold the phone steady" (at most every 15 s).
- **Beeps**: quiet proximity beeps from the ESP8266 distance sensor. Silent beyond 2 m; faint and slow from 2 m, getting louder, faster and higher toward 10 cm, where they're fast and loud. They go quieter while the voice speaks, except at 10 cm or less. **Beep volume** sets the loudness; **Intensity** (0.5×–2×) makes them ramp up sooner (higher) or later (lower). The header shows the distance, "sensor: clear" or "sensor offline".
- **Frame every**: how often a frame is sent (default 0.4 s). Up to 3 requests run at once. The top bar shows how long the last reply took, and how much of that was the model.
- **⇄** (Diagnostics overlay only): switches to the front camera and back. Turning Diagnostics off returns to the rear camera. It's hidden otherwise because the front camera can't see where you're walking.

## How it works

The app is tuned for a blind pedestrian. It reports only hazards (stairs, curbs, potholes, obstacles, approaching vehicles), navigation cues (doors, crosswalks, turns) and large readable text (building and room names), in 12 words or fewer.

`public/app.js` scales each frame to 768 px and sends it as a JPEG data URL to `POST /api/describe`, along with the last 5 alerts shown. `server.js` builds the request with `prompt.js`, adds the API key and calls `https://api.perceptron.inc/v1/chat/completions` with reasoning off. The API key never reaches the phone.

The model takes about 0.9 s per frame, so the app doesn't wait for one reply before sending the next frame. A new frame goes out every 0.4 s, with up to 3 in flight, and a reply is dropped if a newer frame has already been answered. In a simulated walk, a new scene's alert appeared 1.0–1.6 s after the scene changed. Waiting for each reply before sending the next frame took 1.5–1.7 s.

Alerts give a position (left, ahead, right, and "close" for things within about 2 steps) but no distances. The one exception is stairs, which get an estimated minimum count, e.g. "Stairs down ahead, at least 8 steps."

The model replies `n/a` when nothing new and important is visible. `public/filter.js` also drops near-repeats of alerts already shown in the current view, except when a hazard has become "close" or new text appears, such as a different room number. The status says which happened: "nothing new" or "already said".

To detect when the camera turns to a new view, the app compares a 24×18 grayscale thumbnail of each frame with the first frame of the current view. When they differ enough (`VIEW_CHANGE` in `app.js`), the old alert moves to history, the "already said" list is cleared, and replies still in flight for the old view are ignored. The new view is then described from scratch.

Edit the prompt in `prompt.js`. Setting `MOTION_FRAMES = true` in `public/app.js` sends the previous frame along with the current one so the model can judge motion. It is off because, in testing, it produced false "approaching" alerts.

Optional environment variables: `PERCEPTRON_MODEL`, `PORT` (default 8080), `HTTPS_PORT` (default 8443).

## Saved descriptions (dataset)

**⚙ Settings → Data → Save descriptions** (off by default, set separately on each phone).

- **What's sent:** each alert the phone shows goes to the server, which appends one line to `narrator/data/<YYYY-MM-DD>.jsonl` on that computer. Text only: no images, no location.
- **Who it came from:** every phone gets a random phone ID (shown under the switch). Each **Start** begins a new session.
- **In git:** `narrator/data/` is gitignored, so collected data is never committed.

Each session's lines start with a `start` record (settings and the camera in use) and end with a `stop` record (session length and number of alerts). In between are the `alert` records, plus one `quiet` record for each stretch of 5 s or more with no new alert, so a gap in the data means quiet walking, not a closed app. An alert line looks like:

```json
{"t":"2026-10-18T08:41:03.112Z","type":"alert","phone":"1e9211ae-…","session":"101af34c-…","n":1,
 "text":"Drop-off: stairs going down ahead, at least 3 steps.",
 "words":["drop-off","stairs","going","down","ahead","at","least","3","steps"],
 "hazard":"drop","positions":["ahead"],"close":false,"stairs":{"direction":"down","minSteps":3},
 "quoted":[],"source":"fast","reasoning":"none","style":"safety","clientTime":"…"}
```

The other record types look like:

```json
{"type":"start","reasoning":"none","style":"safety","intervalMs":400,"voice":true,"camera":"Back Ultra Wide · 1440×1920", …}
{"type":"quiet","seconds":10.2, …}
{"type":"stop","seconds":600,"alerts":37, …}
```

Field notes:

- `hazard` is `trip`, `drop`, `head`, `moving`, `obstacle` or `null`.
- `quoted` holds sign text the model quoted.
- `source` is `fast`, or `refine` for a Fast + Low correction.
- `t` is the server's clock.

The parsing lives in `data.js`; check it with `node narrator/eval/data-test.js`. Sign text such as room or building names can reveal where someone walked, so ask people before turning this on for them.

## Distance sensor (ESP8266)

`esp8266_main.ino` sends a reading every ~200 ms. Put the address the server prints at startup (`ESP8266: set serverUrl to http://<laptop-ip>:5000/distance`) into `serverUrl`, and make sure the board joins the same Wi-Fi as the laptop.

On macOS, port 5000 is usually taken by the AirPlay Receiver. Turn it off under System Settings > General > AirDrop & Handoff, or point the sketch at port 8080 instead (`/distance` works there too). Another option is `DISTANCE_PORT=5050 node server.js`, with that port in the sketch.
