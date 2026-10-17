# Live Scene Narrator

A phone web app that streams the camera to the [Perceptron](https://docs.perceptron.inc) vision-language API (`perceptron-mk1.5`) and shows a live description of your surroundings.

## Run

```sh
cd narrator
echo 'PERCEPTRON_API_KEY=your_key_here' > .env   # or export it
node server.js
```

The app needs Node 18 or later and has no npm dependencies. On startup the server prints:

- `http://localhost:8080`, for a laptop with a webcam
- `https://<your-lan-ip>:8443`, to open on a phone on the same Wi-Fi

Phones only allow camera access on HTTPS pages, so the server creates a self-signed certificate in `certs/` the first time it runs. When the phone shows a certificate warning, tap through it: **Show details → visit website** on iOS, **Advanced → Proceed** on Android.

To get a real HTTPS URL instead, which also works off your Wi-Fi, run a tunnel to port 8080, for example `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`.

## Use

- **Start / Stop**: opens the rear camera and begins narrating. The next frame is sent as soon as the previous description finishes.
- **Gap**: the minimum time between frames, if you want fewer API calls.
- **⇄**: switches between the front and rear cameras.

## How it works

`public/app.js` scales each frame down to 512 px and sends it as a JPEG data URL to `POST /api/describe`, along with the previous description, so the model can reply "No change." when the scene is the same (the caption then stays as it is). `server.js` adds the API key and calls `https://api.perceptron.inc/v1/chat/completions` with `stream: true` and reasoning off. It sends the reply back to the phone as plain text, so the caption fills in word by word. The API key never reaches the phone.

Optional environment variables: `PERCEPTRON_MODEL`, `PORT` (default 8080), `HTTPS_PORT` (default 8443).
