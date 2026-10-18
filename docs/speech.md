# Speech (ElevenLabs)

Code: `narrator/public/speech.js`, and `speak()`, `startSpeech()` and the early-speech functions in `narrator/server.js`.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | none | Without it, `/api/speak` returns 503 and the app runs silently (text only) |
| `ELEVENLABS_MODEL` | `eleven_v4_turbo` | Most realistic real-time model. `eleven_flash_v2_5` is faster but less natural |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George, British) | Any voice ID from your ElevenLabs account; the voice determines the accent |
| `ELEVENLABS_SAMPLE_RATE` | 24000 | Raw 16-bit PCM. 44100 needs the ElevenLabs Pro tier |
| `ELEVENLABS_TAG` | `[rapidly]` | Delivery tag added before the text for v3/v4 models; not spoken aloud |
| `ELEVENLABS_SPEED` | 1.2 | Used by non-v3/v4 models only (max 1.2) |
| `ELEVENLABS_EARLY` | on | `0` turns off early speech start |

## Pipeline

1. **Early start (server):** when Perceptron replies, `describe()` runs the same filter the phone will. If the reply is a new alert, `startSpeech()` begins the ElevenLabs request immediately and buffers the audio, keyed by the alert text.
   - At most 2 run at once; unclaimed jobs are dropped after 15 s.
2. **Request (phone):** `Speech.say(text)` → `makeClip()` → `POST /api/speak {text}`.
   - The server uses the early job if there is one (`X-Speech-Early: 1`); otherwise it starts a new one.
3. **Streaming:** the server passes raw PCM through as it arrives (headers `X-Sample-Rate` and `Server-Timing: tts;dur=…`).
   - `speech.js` converts 16-bit samples to floats and handles a byte split across network chunks.
   - The first chunk is played at once; later chunks are merged to ≥60 ms and scheduled back to back on the Web Audio clock.
4. **Queue:** clips play in order. Each starts downloading the moment it's queued, so the next is usually ready when the current one ends. Nothing is dropped.
5. **Hazards first:** an alert with a hazard label is spoken with `Speech.say(text, { urgent: true })` (`app.js` `showAlert`).
   - It stops a non-hazard clip that is playing and drops queued non-hazard clips. Hazard clips never cut each other, and stay in order.
   - Implemented with per-clip cancellation (`dropNonUrgent`), so the global cancel isn't used.
   - Tested: 8 checks with fake audio.
6. **Interrupt** (Settings → Speech): a new alert, of any kind, cuts off the current clip and drops older queued ones.

**Measured:** first audio ~0.2 s after the request (~0.4 s cold); reply → first audio 901 → 510 ms with early start (simulated 150 ms phone↔laptop hop); gap between clips < 80 ms in simulation. See [optimization.md](optimization.md).

## Interaction with the rest of the app

- **Pause while speaking** (on by default): the camera doesn't send new frames while `Speech.pending > 0`.
- **Beeps** duck to 30% while speech plays, except at ≤10 cm ([proximity-sensor.md](proximity-sensor.md)).
- **Tap the alert card** to hear it again (`ui.js`).
- **Blur hint:** "Hold the phone steady." is spoken after 3 s of blurry frames, at most every 15 s, and isn't added to the "already said" list.
- **Voice toggle** (bottom bar): turns speech off and cancels the queue.

## Robustness

- **iOS audio unlock:** iOS only plays sound started from a tap. `Speech.unlock()` runs synchronously in the Start tap (before any `await`): it creates and resumes one `AudioContext` and plays a silent sample. Every later clip and every beep uses that context.
- **Retries:** one retry if a request fails before any audio arrives.
- **Stall watchdog:** a download that receives nothing for 8 s (`STALL_MS`) is given up, so a hung request can't pause the camera forever.
- **No key (503):** voice switches off and the reason is shown in the diagnostics overlay.
- **Cancel** (Stop, Interrupt, Voice off): aborts downloads, empties the queue, stops all scheduled audio.

## Measured choices

- v4 Turbo **ignores** `voice_settings.speed`, so the tag is the only speed control for it.
- Times for 3 alerts:

  | Tag | Time |
  |---|---|
  | none | 10.16 s |
  | `[speaking quickly]` | 8.32 s |
  | `[rapidly]` | **7.44 s** |

- Speech-to-text transcripts confirmed the tags aren't spoken.
- **MP3 vs PCM:** MP3 had to be fully downloaded and decoded (~0.7–0.9 s+) before playing; PCM plays from the first chunk (~0.2 s).

## Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| **ElevenLabs, not the browser's built-in voice** | The browser `speechSynthesis` version lagged about 10 s behind the alerts on the test phone and sounded robotic. The user asked for realism and speed, with unlimited credits. | `speechSynthesis` (removed); Grok TTS (an earlier plan). |
| **`eleven_v4_turbo`** | The most realistic of ElevenLabs' real-time models (~100 ms inference). | Flash v2.5: ~75 ms but noticeably less natural; Eleven v4: best quality but not real-time. |
| **Raw PCM streamed, not MP3** | PCM can be played from the first chunk (~0.2 s); MP3 had to be fully downloaded and decoded first (~0.7–0.9 s+). | MP3 via `<audio>`. |
| **Early start on the server** | The server sees the model's reply first; starting speech there saves a phone↔laptop round trip (median 901 → 510 ms with a simulated 150 ms hop). The phone's request then picks up the job already running. | Starting only when the phone asks. |
| **Queue, nothing dropped (default)** | The user asked that no alert be lost. Each clip downloads as soon as it is queued, so the next is ready when the current one ends. | Dropping older alerts by default (kept as the Interrupt option). |
| **Hazards cut in** | A hazard must not wait behind a sign reading. Hazards never cut other hazards, so no warning is lost. | Strict order for everything; or every new alert cutting in. |
| **`[rapidly]` tag for speed** | v4 Turbo ignores the speed setting; this tag was the fastest of those tried (7.44 s vs 10.16 s for 3 alerts) and isn't spoken. | Flash v2.5 at speed 1.2 (faster, less natural; available via `ELEVENLABS_MODEL`). |
| **Web Audio, one context unlocked in the Start tap** | iOS only allows sound started from a tap; one context unlocked there plays everything afterwards, and allows sample-accurate scheduling of chunks. | A new `<audio>` element per clip (blocked on iOS). |
| **Pause sending frames while speaking (toggle)** | Each alert is heard in full before the app looks again, so speech doesn't fall behind the scene. Optional, because it means nothing new is noticed for 2–3 s. | Always sending. |
| **One retry and an 8 s stall watchdog** | Mobile networks drop requests; one retry recovers most failures, and the watchdog stops a hung download from pausing the camera forever. | Unlimited retries; no timeout. |

## Not yet confirmed on a phone

Everything above was tested with the real ElevenLabs API through the server, and in a simulated browser (12 queue checks plus a stall test). Listening on a phone is still to do.
