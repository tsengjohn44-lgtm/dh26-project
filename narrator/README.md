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

- **Start / Stop**: opens the rear camera and begins narrating. The app uses the widest view it can get: the ultra-wide lens when the browser offers it (iOS Safari lists it as "Back Ultra Wide Camera"), otherwise the lowest zoom, at 4:3 so the full sensor is used. The top bar shows which camera is in use.
- **Voice**: speaks each new alert with ElevenLabs (`eleven_v4_turbo`). Audio is streamed, and the server starts generating it as soon as Perceptron replies, before the alert reaches the phone. A "speak quickly" instruction makes delivery about 15–20% faster. By default alerts are queued and spoken in order, with none skipped. The top bar shows how quickly speech started and how many clips are waiting. Requires `ELEVENLABS_API_KEY`; set `ELEVENLABS_VOICE_ID` to use a different voice. For even faster but less natural speech, set `ELEVENLABS_MODEL=eleven_flash_v2_5`; it speaks at `ELEVENLABS_SPEED`, default 1.2.
- **Phones** go fullscreen and lock to portrait on Start. This stops the screen from turning over when you tilt the phone, which made the camera image upside down on Android.
- **Interrupt**: when on, a new alert cuts off the one being spoken and skips anything queued, so you always hear the latest.
- **Frame every**: how often a frame is sent (default 0.4 s). Up to 3 requests run at once. The top bar shows how long the last reply took, and how much of that was the model.
- **⇄**: switches between the front and rear cameras.

## How it works

The app is tuned for a blind pedestrian. It reports only hazards (stairs, curbs, potholes, obstacles, approaching vehicles), navigation cues (doors, crosswalks, turns) and large readable text (building and room names), in 12 words or fewer.

`public/app.js` scales each frame to 768 px and sends it as a JPEG data URL to `POST /api/describe`, along with the last 5 alerts shown. `server.js` builds the request with `prompt.js`, adds the API key and calls `https://api.perceptron.inc/v1/chat/completions` with reasoning off. The API key never reaches the phone.

The model takes about 0.9 s per frame, so the app doesn't wait for one reply before sending the next frame. A new frame goes out every 0.4 s, with up to 3 in flight, and a reply is dropped if a newer frame has already been answered. In a simulated walk, a new scene's alert appeared 1.0–1.6 s after the scene changed. Waiting for each reply before sending the next frame took 1.5–1.7 s.

Alerts give a position (left, ahead, right, and "close" for things within about 2 steps) but no distances. The one exception is stairs, which get an estimated minimum count, e.g. "Stairs down ahead, at least 8 steps."

The model replies `n/a` when nothing new and important is visible. `public/filter.js` also drops near-repeats of alerts already shown in the current view, except when a hazard has become "close" or new text appears, such as a different room number. The status says which happened: "nothing new" or "already said".

To detect when the camera turns to a new view, the app compares a 24×18 grayscale thumbnail of each frame with the first frame of the current view. When they differ enough (`VIEW_CHANGE` in `app.js`), the old alert moves to history, the "already said" list is cleared, and replies still in flight for the old view are ignored. The new view is then described from scratch.

Edit the prompt in `prompt.js`. Setting `MOTION_FRAMES = true` in `public/app.js` sends the previous frame along with the current one so the model can judge motion. It is off because, in testing, it produced false "approaching" alerts.

Optional environment variables: `PERCEPTRON_MODEL`, `PORT` (default 8080), `HTTPS_PORT` (default 8443).
