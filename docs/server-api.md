# Server and API (`narrator/server.js`)

A zero-dependency Node 18+ server: `node narrator/server.js`. It serves the phone app, proxies Perceptron and ElevenLabs (keys stay on the server), and relays the distance sensor.

## Endpoints

### `POST /api/describe`: frame → Perceptron
- **Request (JSON, ≤16 MiB):** `{ image: "data:image/jpeg;base64,…", said?: string[], reasoning?: "none"|"low"|"high", style?: "safety"|"classic", sensor?: { distanceM, heightM }, prevImage?, prevDtMs? }`. `sensor` is ignored unless distance is 0.02–4.5 m and height 0–3 m.
- **What it does:**
  - `prompt.js` `buildPayload()` builds the request; then `POST https://api.perceptron.inc/v1/chat/completions`, non-streaming.
  - If the reply is a new alert by the same filter the phone uses, it starts the speech for it early (see `/api/speak`).
- **Response:** `200 text/plain` with the model's reply (an alert, or `n/a`). Header `Server-Timing: api;dur=<ms>` gives the Perceptron time.
- **Errors:** 400 bad input · 429/503 passed through with `Retry-After` · 502 other upstream errors. The upstream request is aborted if the phone disconnects.

### `POST /api/ask`: spoken question + frame → answer
- **Request (JSON, ≤16 MiB):** `{ image: "data:image/jpeg;base64,…", audio: "<base64 16 kHz mono WAV, no data: prefix>", reasoning?: "none"|"low"|"high", sensor?: { distanceM, heightM } }`. Audio is limited to ~2 MB base64 (the app caps recordings at 15 s).
- **What it does:** the same path as `/api/describe`, with `buildAskPayload`: one Perceptron request with `image_url` + `input_audio` (`format: 'wav'`) + `ASK_PROMPT`. Speech for the answer starts early (stair counts and stair labels fixed first, matching the phone).
- **Response:** `200 text/plain` answer (≤2 sentences) with `Server-Timing: api;dur=<ms>`.
- **Errors:** 400 (missing or non-base64 audio, bad image) · 429/503 · 502, as for describe. See [questions.md](questions.md).

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
| `QR` | on | `0` hides the startup QR code |

The startup log prints the model and voice settings, the desktop URL, the phone URLs (including `https://<mac-name>.local:8443`), and the `serverUrl` for the sketch. Below the phone URLs it draws a **QR code of the numeric-IP link** (`https://<lan-ip>:8443`, the first LAN address): point the phone's camera at the terminal to open it. `QR=0` turns it off.

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

## Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| **Node built-ins only** (`http`, `https`, `fetch`) | Runs anywhere with Node 18+, nothing to install; the server is ~450 lines. | Express or Fastify: no feature here needs them. |
| **The server is a thin proxy** | It adds the keys, builds the request from one shared module (`prompt.js`), and returns text. All "what to show" logic is on the phone ([architecture.md](architecture.md)). | Server-side filtering and state per phone. |
| **`prompt.js` shared by the server and the test scripts** | Evaluations send exactly what the app sends, so measurements apply to the real app. | Copying the request into each test. |
| **`text/plain` replies with `Server-Timing`** | The reply is one short line; `Server-Timing` lets the phone split total time into model time and network time (shown in the 🐞 overlay). | JSON wrappers. |
| **429/503 passed through with `Retry-After`** | The phone backs off for exactly as long as Perceptron asks. | Retrying on the server, which hides the rate limit. |
| **Abort the upstream request when the phone disconnects** | Stop, or a newer view, shouldn't keep paying for a reply nobody will see. | Letting it finish. |
| **Self-signed certificate made at startup** | Phones only allow the camera and mic over HTTPS; this works on any Wi-Fi with no account or domain. Rebuilt only if the `.local` name is missing, not when the IP changes, so the phone doesn't need to accept a new warning every time. | A tunnel service (needs internet and an account); a real certificate (needs a domain). |
| **`.local` name in the certificate** | The laptop's IP changes between networks; `https://<mac>.local:8443` keeps working. | IP-only access. |
| **Early speech jobs held in memory, max 2, 15 s** | A job is useful only for the next second or two; the limits cap wasted ElevenLabs requests when the phone skips an alert. | No limit; storing on disk. |
| **Body size limits** (16 MiB frames, 64 KiB speech, 4 KiB sensor) | Stops accidental or malicious huge requests from exhausting memory. | No limits. |
| **QR code of the IP link, drawn in the terminal** (`narrator/qr.js`) | Typing `https://10.44.x.x:8443` on a phone is slow and error-prone. The numeric-IP link works on every phone and network, unlike `.local`. A small built-in encoder (byte mode, level M, versions 1–10) keeps the project dependency-free. It's drawn with half-block characters in explicit black and white, so it scans on dark and light terminal themes. Verified by decoding with macOS's QR detector: 12/12 test strings across all 10 sizes, and the exact text the server prints. | The `qrcode` npm package (a dependency); printing a link only. |
| **No authentication (yet)** | A demo on a private network; anyone on the same Wi-Fi who knows the address could use the keys' credits. Add auth before any wider deployment. | Accounts: out of scope for the hackathon. |

## Perceptron and ElevenLabs facts

See [vision.md](vision.md) §8 and [speech.md](speech.md).
