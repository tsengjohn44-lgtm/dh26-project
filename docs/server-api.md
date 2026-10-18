# Server and API (`narrator/server.js`)

A zero-dependency Node 18+ server: `node narrator/server.js`. It serves the phone app, proxies Perceptron and ElevenLabs (keys stay on the server), and relays the distance sensor.

## Endpoints

### `POST /api/describe`: frame → Perceptron
- **Request (JSON, ≤16 MiB):** `{ image: "data:image/jpeg;base64,…", said?: string[], reasoning?: "none"|"low"|"high", prevImage?, prevDtMs? }`
- **What it does:**
  - `prompt.js` `buildPayload()` builds the request; then `POST https://api.perceptron.inc/v1/chat/completions`, non-streaming.
  - If the reply is a new alert by the same filter the phone uses, it starts the speech for it early (see `/api/speak`).
- **Response:** `200 text/plain` with the model's reply (an alert, or `n/a`). Header `Server-Timing: api;dur=<ms>` gives the Perceptron time.
- **Errors:** 400 bad input · 429/503 passed through with `Retry-After` · 502 other upstream errors. The upstream request is aborted if the phone disconnects.

### `POST /api/speak`: text → audio
- **Request (JSON):** `{ text }` (≤500 characters).
- **What it does:** uses an early-started job for this text if there is one; otherwise calls ElevenLabs `POST /v1/text-to-speech/{voice}/stream?output_format=pcm_<rate>`. The `ELEVENLABS_TAG` is prepended for v3/v4 models, and `voice_settings.speed` is sent.
- **Response:** `200 application/octet-stream`, raw 16-bit little-endian mono PCM, streamed as it is generated. Headers:
  - `X-Sample-Rate`
  - `X-Speech-Early: 1|0`
  - `Server-Timing: tts;dur=<time to first byte>`
- **Errors:** 503 no ElevenLabs key · 429 passed through · 502 other errors.
- **Early jobs:** at most 2 at once; unclaimed ones are dropped after 15 s.

### `POST /distance`: ESP8266 reading
- **Request (form-encoded):** `distance=<metres>|Out_of_Range`, plus optional `uptime`, `rssi`, `drops` and `reset` health fields.
- **Response:** 204, or 400 for a bad value.
- Served on every port, including the plain-HTTP `DISTANCE_PORT`.

### `GET /api/distance/stream`: Server-Sent Events
- Pushes `data: {"metres":…|null,"at":…}` for each reading. A new connection first gets the latest reading with `ageMs`.
- Keep-alive comment every 15 s.

### `GET /…`: static files
- Serves `narrator/public/`. Path traversal is blocked, and files are sent `Cache-Control: no-cache`.

## Environment variables (`narrator/.env` or the shell)

| Variable | Default | Purpose |
|---|---|---|
| `PERCEPTRON_API_KEY` | **required** | The server exits without it |
| `PERCEPTRON_MODEL` | `perceptron-mk1.5` | Only Mk1.5 and Mk1 are available; Isaac models are retired |
| `ELEVENLABS_API_KEY` | none | Optional; without it, speech is off |
| `ELEVENLABS_MODEL` | `eleven_v4_turbo` | `eleven_flash_v2_5` is faster but less natural |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` | Sets the voice and accent |
| `ELEVENLABS_SAMPLE_RATE` | `24000` | 44100 needs the ElevenLabs Pro tier |
| `ELEVENLABS_TAG` | `[rapidly]` | Delivery tag for v3/v4; empty disables |
| `ELEVENLABS_SPEED` | `1.2` | Non-v3/v4 models only; max 1.2 |
| `ELEVENLABS_EARLY` | on | `0` disables early speech start |
| `PORT` | `8080` | HTTP |
| `HTTPS_PORT` | `8443` | HTTPS for phones |
| `DISTANCE_PORT` | `5000` | Plain HTTP for the ESP8266; on macOS often taken by AirPlay Receiver |

The startup log prints the model and voice settings, the desktop URL, the phone URLs (including `https://<mac-name>.local:8443`), and the `serverUrl` for the sketch.

## HTTPS and addresses

- Phones only allow camera access over HTTPS, so the server creates a self-signed certificate with `openssl` in `narrator/certs/` (gitignored). The phone must accept the warning once.
- The certificate names `localhost`, `<mac-name>.local`, `127.0.0.1` and the current LAN IPs.
- It is rebuilt only if the `.local` name is missing, **not** when the IP changes, so the phone doesn't need to accept a new warning every time.
- `https://<mac-name>.local:8443` works on Android 12+ and iPhones on networks that allow local names; otherwise use the printed IP.
- Off-network alternative: `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`.

## Security notes

- API keys are read from `.env` (gitignored) and used only on the server. The phone never sees them.
- The ESP8266 sketch contains Wi-Fi credentials in plain text: keep the repo private, or move them out of the sketch.
- Request body limits: 16 MiB for frames, 64 KiB for speech text, 4 KiB for sensor readings.
- The plain-HTTP ports serve the same routes as HTTPS. Anyone on the same network who knows the address can use the app, and through it spend the keys' credits. Fine for a demo; add authentication before any wider deployment.

## Perceptron and ElevenLabs facts

See [vision.md](vision.md) §8 and [speech.md](speech.md).
