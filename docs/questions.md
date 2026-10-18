# Asking questions by voice (🎤 Ask)

Code: `narrator/public/recorder.js` (microphone → WAV), `askQuestion` flow in `narrator/public/app.js` (`startAsk`, `finishRecording`, `showAnswer`, `endAsk`), `ASK_PROMPT` / `buildAskPayload` in `narrator/prompt.js`, and `POST /api/ask` (`describe(…, { ask: true })`) in `narrator/server.js`.

## How it works

1. **Tap 🎤 Ask once and speak.** The question is sent automatically when you stop talking (about 1.2 s of quiet). Tapping again sends at once. Holding also works: while the button is held, pauses don't send, and releasing does. Screen readers' double-tap and Enter act as taps.
   - The app only listens while running; before Start it says "Tap Start first, then ask".
   - A rising tone and a short vibration mean "listening"; a falling tone means "sent"; a low tone means "Didn't hear a question" (no speech within 6 s, nothing sent).
   - The rising tone plays *before* the microphone opens: once it's open, Android turns playback down, and the tone was inaudible (only the vibration was felt).
2. **While asking:** narration pauses, any speech stops, and the beeps are muted, so the microphone hears only the question.
3. **Recording** (`recorder.js`):
   - Raw microphone samples are read through the app's Web Audio context (an `AudioWorklet`, falling back to `ScriptProcessorNode`), with echo cancellation, noise suppression and auto gain on.
   - On release they are downsampled to 16 kHz, encoded as 16-bit mono WAV, and base64-encoded.
   - `MediaRecorder` isn't used: its formats (webm/opus, mp4/aac) aren't accepted by Perceptron.
   - **End of speech** (`createSpeechDetector`, pure and tested in Node):
     - the noise floor is the quietest level in the first 250 ms, then follows slow changes
     - speech means a level above max(0.015 RMS, 3× the floor) for 200 ms in total, so clicks and bumps don't count
     - the question ends after 1.2 s below 0.7× that threshold, which allows normal pauses between words
     - silence after the last speech is trimmed to 300 ms before sending
   - Limits: 15 s maximum (auto-stop); under 0.4 s is treated as an accidental tap and not sent.
   - The microphone is released immediately: on an iPhone, an open mic keeps audio in "call" mode, which is quieter and may use the earpiece.
4. **Request:** `POST /api/ask {image, audio, reasoning}`.
   - The current frame comes from `grabFrame`, upright, with Android flip correction applied.
   - The reasoning level follows Settings; Fast + Low uses Off for questions.
   - The server sends Perceptron **one request with the image and the audio** (`input_audio`, `format: 'wav'`). There is no separate speech-to-text.
5. **Answer:**
   - shown in the alert card and spoken **first** (urgent: cuts in ahead of other speech)
   - never repeat-filtered, and not added to "already said", so the narration's filtering isn't affected
   - stair counts get the same cautious ×0.75 adjustment as alerts
   - tap the card to hear the answer again
   - narration resumes afterwards
6. **Early speech:** the server starts generating the answer's audio as soon as Perceptron replies, keyed on the exact text the phone will speak.
7. **Distance sensor:** with Share distance with AI on and a valid reading, the request also carries `sensor: { distanceM, heightM }`; see [vision.md](vision.md).

## The prompt (`ASK_PROMPT`)

- **Answer the spoken question** about the image, in at most 2 short sentences.
- **Safety first:** dangers come first, with the hazard labels.
- **"Is it safe to walk?"** with stairs, curbs, edges, holes, uneven ground or obstacles in the path → "No" or "Careful", naming each one. Never "it's safe" when one is visible.
- **Stairs:** going up or down, plus "at least N steps".
- **Text:** quote readable text exactly, including arrow directions.
- **Honesty:** only say what's visible; say so if the image can't answer. If the question wasn't understood: "Sorry, I didn't catch that."
- **Reasoning** follows Settings. Fast + Low uses Off for questions. The output cap is 90 tokens (2048 with reasoning).

## Measured (real APIs, 2026-10-18)

- **Method:** questions were generated with ElevenLabs as 16 kHz speech, resampled to 48 kHz (a typical phone microphone rate), and passed through our own `downsample` + `encodeWav`, then `/api/ask` on the real server.
- **First prompt:** 5/6, but with real problems:
  - "Is it safe to keep walking forward?" on stairs going up → "Yes, it appears safe…"
  - "approximately 15 steps" instead of a cautious "at least" count
  - one answer gave the sign's arrow as left (it points right)
- **After the safety and stairs rules:** 14/14 correct over 7 questions × 2 runs:
  - the sign read with the arrow to the right
  - stairs down "at least 7–9 steps"
  - "Careful, there are at least 10 stone steps ahead going up."
  - "Careful, there is a curb ahead."
  - the building named
- **Latency:** median 660 ms, max 944 ms (about the same as a normal frame).
- **Audio cost:** a 3–4 s question is about 45 audio tokens; the image is about 500.
- **Wording:** a first safety phrasing made the model echo "not simply safe". It was reworded to "No" / "Careful".

## Auto-send measurements (2026-10-18)

- **Synthetic audio** (11 checks): sent about 1.2 s after speech ends; a 0.6 s pause mid-question doesn't end it; noise only → "no speech" at 6 s; 100 ms clicks aren't speech; still works over loud steady background noise; trimming is correct.
- **Real ElevenLabs speech** (0.6 s room noise, the question, then 3 s of noise, 48 kHz, through the real `/api/ask`): all 3 were sent automatically 0.9–1.2 s after speaking stopped. The hesitant "Hmm, what is, uh... what is in front of me?" wasn't cut off. Answers came in 0.45–0.62 s.
- **Fake browser:** tap → callbacks wired; silence → sent with no second tap; held → silence ignored, release sends; no speech → nothing sent, mic released; a 405 (out-of-date server) → "Server is out of date: restart node server.js".

## Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| **One Perceptron request with the image and the audio** | Mk1.5 accepts audio directly, so the model hears the question and sees the scene together, with no speech-to-text step: one round trip (~0.5–0.7 s). | Speech-to-text first (e.g. ElevenLabs `scribe_v2`) then a text question: a second call and more delay. |
| **WAV encoded in the browser** | Perceptron accepts WAV; the browser's `MediaRecorder` only makes webm/opus or mp4/aac. Raw samples from Web Audio, downsampled to 16 kHz mono, are small (~32 KB per second) and accepted. | `MediaRecorder` + converting on the server (needs ffmpeg). |
| **Release the microphone immediately** | On iPhone an open microphone keeps audio in "call" mode: quieter, possibly the earpiece. | Keeping the mic open between questions. |
| **Auto-send on silence** | The user asked not to tap twice. A simple loudness detector is enough for one speaker close to the phone, costs nothing and works offline. Tuned: 1.2 s of quiet (normal pauses survive), speech must last 200 ms (clicks don't count), the threshold follows the background noise. | Browser speech recognition (`SpeechRecognition`: not on all browsers, sends audio to Google or Apple, opens its own mic session); ML voice detectors (a large download). |
| **Hold-to-talk and tap-to-send still work** | Holding lets the user pause to think without the question being sent; a tap sends at once when the user knows they're done. | Auto-send only. |
| **Tone before the mic opens** | Once the mic is open, Android turns playback down, and the start tone went unheard (only the vibration was felt). | Tone after opening. |
| **Narration paused, speech and beeps silenced while asking** | The microphone must hear only the question; the beeps and the voice would be recorded too. | Echo cancellation alone. |
| **Answers spoken first, not added to "already said"** | The user asked a question and is waiting; and an answer shouldn't stop the narration from reporting the same thing later. | Treating answers as alerts. |
| **The same safety rules as narration** | Asked "Is it safe to walk?" in front of stairs, the first prompt said "Yes, it appears safe". Answers now must say "No" or "Careful" and name the hazard, with the same stair-count and stair-label fixes in code. | A neutral question-answering prompt. |
| **Distance only if asked** | With Share distance with AI on, questions also carry the sensor reading. The model may give a rough distance only when the question asks how far; otherwise it follows the narration rule. | Never giving it (unhelpful for "how far is the door?"). |

## Tests

- **Encoder unit tests** (6): 48 → 16 kHz keeps the duration, a valid WAV header, sample clamping, base64 round trip, the payload's shape, and rejecting bad audio.
- **Fake browser** (14 checks in `narrator/eval/suites/app_test.cjs`):
  - not running → hint
  - hold: recording, speech cancelled, beeps muted, no narration frames sent
  - release: frame and audio sent; answer shown and spoken urgent, not added to `said`; beeps and narration resume
  - tap-to-toggle; keyboard/screen-reader click toggle
  - too-short recording; microphone denied; Stop while recording releases the mic

## Not yet confirmed on a phone

- iPhone audio after recording: volume and speaker vs earpiece. Releasing the mic immediately should restore normal output.
- Android Chrome/Edge microphone capture and the `AudioWorklet` path.
- The hold gesture with TalkBack and VoiceOver.
- Real speech in a noisy street, and whether 1.2 s of silence is right: too short cuts off slow speakers, too long feels sluggish (`SILENCE_MS` in `recorder.js`).

## Possible next steps

- Show a transcript ("You asked: …"). Perceptron doesn't return one; it would need ElevenLabs speech-to-text (`scribe_v2`) as a second call.
- Follow-up questions with conversation history (Perceptron is stateless, so the app would resend the previous question and answer).
