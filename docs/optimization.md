# Speed and efficiency optimizations

This document lists every change made for speed or efficiency since the first working build, with what was measured before and after. It also lists what was tried and rejected, so nobody repeats the experiment, and what still limits speed.

## The baseline (first build)

| Area | Baseline behaviour |
|---|---|
| Frame sending | **One request at a time**: capture → wait for the reply → capture again |
| Frames | 1280×720 (16:9) camera, scaled to **512 px**, JPEG quality 0.7 |
| Request | `max_tokens: 120`. Perceptron doesn't recognise this field and ignores it, so output was effectively uncapped. Reasoning not set. Reply streamed token by token |
| Prompt | "1–2 short sentences" describing the scene; one previous description as context |
| Output | ~35 words (~43 output tokens) per reply, e.g. two sentences about a sailboat |
| Speech | Browser `speechSynthesis`, each sentence queued behind the last |
| Repeats | Only "No change." from the model; no app-side filtering |

Measured problems with the baseline:
- **Speech fell about 10 s behind the screen:** descriptions arrived every ~1.3 s but took 6–10 s to say.
- **A scene change took 1.5–1.7 s to reach the screen**, because each request waited for the previous one.

## Summary

| # | Change | Before → after (measured) |
|---|---|---|
| 1 | Overlapping requests (3 in flight, a new frame every 0.4 s) | Scene change → alert **1.5–1.7 s → 0.7–1.5 s**; 65 → ~140 requests/min |
| 2 | Real output cap (`max_completion_tokens`) and short alerts (≤12 words) | ~43 → ~17 output tokens per reply; spoken length ~5 s → ~1–3 s |
| 3 | Reasoning explicitly off by default | Median **0.48 s** per frame (Low 1.3 s, High 4.9 s) |
| 4 | "Think briefly" for Low reasoning | Median **2.1 → 1.35 s**, worst **6.9 → 3.0 s**, thinking tokens ~330 → ~170 |
| 5 | "Fast + Low" hybrid mode | Fast alert stays ~0.5 s; reasoning corrections follow ~1 s later instead of delaying every alert |
| 6 | Non-streaming replies | Same speed (a reply streams in ~0.1 s), simpler, and enables filtering |
| 7 | ElevenLabs instead of browser speech | Removed the ~10 s speech backlog; realistic voice |
| 8 | Streamed raw audio (PCM) instead of MP3 | First audio **~0.7–0.9 s (+decode) → ~0.2 s** |
| 9 | Early speech start on the server | Reply → first audio **901 → 510 ms** (with a 150 ms phone↔laptop hop) |
| 10 | Speech prefetch queue | Gap between consecutive clips **< 80 ms** (next clip already generated) |
| 11 | `[rapidly]` delivery tag | Speaking time **10.16 → 7.44 s** for 3 alerts (−27%) |
| 12 | Blur gate | Blurry frames aren't sent (no wasted request, no wrong answer); re-checked after 100 ms |
| 13 | Repeat filter + `n/a` + view-change reset | Fewer spoken alerts; nothing said twice for the same view |
| 14 | Pause sending while speaking (toggle) | No requests during speech, so the user hears each alert in full |
| 15 | Stall watchdog on speech downloads | A hung audio request can't pause the camera forever (gives up after 8 s) |
| 16 | Push (Server-Sent Events) for sensor readings | Reading reaches the phone **< 50 ms** after the ESP posts it |
| 17 | Look-ahead audio scheduler for beeps | Beat spacing accurate to **< 5 ms**; speeds up immediately when approaching |
| 18 | Rate-limit awareness | Stays under Perceptron's 300 requests/min; honours `Retry-After` on 429/503 |
| 19 | Timing visibility (`Server-Timing`, latency chip) | Shows model time vs network time on the phone |

---

## Vision requests (camera → Perceptron)

### 1. Overlapping requests
- **Before:** the next frame was captured only after the previous reply came back. A scene change had to wait for a reply about a frame taken *before* the change, then a full new round trip.
- **After:** `loop()` in `public/app.js` sends a frame every `interval` (default 0.4 s), with up to `MAX_IN_FLIGHT = 3` requests open. Replies for frames older than one already handled are dropped (`seq < shownSeq`).
- **Measured:**
  - The API answered 3 concurrent requests about as fast as 1 (median 950 ms vs 893 ms).
  - In a simulated walk through 5 scenes, scene change → alert went from 1.5–1.7 s to 0.7–1.5 s, at 134–146 requests/min.
- **Limit:** Perceptron allows 300 requests/min per organization (see 18).

### 2. Real output cap and short alerts
- **Before:** `max_tokens` isn't in Perceptron's schema and was silently ignored. The prompt asked for 1–2 sentences, so replies were ~35 words.
- **After:** `max_completion_tokens: 40` (`prompt.js`) and a prompt asking for "at most 12 words".
- **Measured:** ~43 → ~17 output tokens. Spoken length went from ~5 s to ~1–3 s per alert, which also shortens the pause-while-speaking window (14).

### 3. Reasoning off by default
- Perceptron can "think" before answering (`reasoning_effort`). It was off by default in our tests, and the app now sends `none` explicitly so this can't change silently.
- **Measured** (4 photos × 2 runs): Off **0.48 s** median, Low 1.3 s, High 4.9 s. Reasoning is opt-in in Settings.

### 4. "Think briefly" for Low reasoning
- Reasoning time is driven by the number of thinking tokens, not the answer, which stays a few words.
- **Change:** when `reasoning === 'low'`, `buildPayload()` appends "Think briefly: at most 3 short sentences of reasoning, then answer." (`BRIEF_REASONING`).
- **Measured, same session:** median **2.1 → 1.35 s**, worst **6.9 → 3.0 s**, thinking tokens ~330 → ~170. Answers stayed correct.
- **Caveat:** through the server, outliers of 3.5–6 s still occurred. That's why 5 exists.

### 5. "Fast + Low" hybrid mode
- Each frame is sent twice: without reasoning (the alert, ~0.5 s) and with Low reasoning (`sendSlow()` in `app.js`).
- The reasoning answer is shown and spoken **only if it adds or corrects something**, e.g. "arrow right" where the fast answer said "arrow left" (`Filter.classifyReply(..., { refine: true })`).
- **Effect:** alerts never wait for reasoning, but corrections still arrive about 1 s later.
- At most 2 reasoning requests run at once (`MAX_SLOW_IN_FLIGHT`), keeping the total under the rate limit (~240/min worst case).

### 6. Non-streaming replies
- **Before:** replies were streamed token by token.
- **After:** `stream: false`.
- **Why:** a 12-word reply streams in ~0.1 s, so streaming saved nothing. Filtering also needs the whole reply before deciding whether to show it.

### 12. Blur gate (efficiency and quality)
- Blurry frames gave **wrong** answers in tests:
  - a room sign lost its numbers
  - a stair count halved
  - a crosswalk photo gained invented "cars approaching"
- **Change:** `pickFrame()` scores each frame's sharpness (`Filter.sharpness`) against recent frames of the same view, and checks the gyroscope (> 90°/s = moving).
  - A blurry frame is **not sent**, and the next frame is checked 100 ms later rather than after the full interval.
  - After 2 s with nothing sharp, the sharpest frame is sent anyway.
- **Calibrated on 29 photos:**
  - caught 29/29 defocused, 27/29 with 9 px and 25/29 with 5 px motion blur
  - **0** false skips for camera shake or brightness changes
- **Not yet tuned on a real phone camera.**

### 13. Fewer, non-repeating alerts
- **The model gates itself:** it answers `n/a` when nothing new and important is visible.
- **`Filter.classifyReply`** drops near-repeats of the last 5 alerts for the current view (≥60% shared content words). Exceptions: new numbers, a hazard becoming "close", and (in hybrid mode) changed directions.
- **View-change reset:** a 24×18 thumbnail comparison clears the "already said" list when the camera turns to a new scene, so new places are described right away.
  - Measured on photos: 0 false resets from shake, 95% of real scene changes detected.
- **Bug fixed:** blank or black frames used to count as a new view every time, which repeated alerts. Two flat frames now count as the same view.
- **Effect:** less speech to queue, so speech falls behind less often.

### 14. Pause sending while speaking (toggle, on by default)
- While an alert is being spoken, no new frames are sent; requests already in flight finish.
- **Effect:** each alert is heard in full, and requests aren't spent on frames whose replies would queue behind the voice.
- **Trade-off:** nothing new is detected during speech, typically 1–3 s per alert. Turn it off in Settings to keep looking.

### 18. Rate-limit awareness
- Perceptron's default limit is 300 chat requests/min per organization, across all keys.
- At the defaults, the app sends ~140/min (Off) or ~240/min worst case (Fast + Low).
- On 429/503 the server passes `Retry-After` through, and the app pauses sending for at least 2 s or the given time.
- **Don't run several phones on one key at short intervals.**

### 19. Timing visibility
- The server adds `Server-Timing: api;dur=<ms>` to every describe reply, and `tts;dur=<ms>` (time to first byte) to every speech reply.
- The diagnostics overlay shows total time vs model time per frame. If the total is much larger than the model time, the delay is the phone↔laptop network, not the model.

---

## Speech (ElevenLabs)

### 7. ElevenLabs instead of browser speech
- **Before:** browser `speechSynthesis`. Each 1–2 sentence description took 6–10 s to say while new ones arrived every ~1.3 s, so speech lagged ~10 s behind.
- **After:** ElevenLabs `eleven_v4_turbo` (their most realistic real-time model, ~100 ms inference), combined with the short alerts (2).

### 8. Streamed raw audio instead of MP3
- **Before:** the phone downloaded the whole MP3 (0.7–0.9 s for a typical alert), then decoded it, then played it.
- **After:** the server requests raw 24 kHz 16-bit audio (`pcm_24000`) and streams it through. `speech.js` plays each chunk as it arrives on a Web Audio clock.
- **Measured through the server:** first audio **~0.2 s** after the request (~0.4 s on a cold connection).

### 9. Early speech start on the server
- **Before:** speech generation started only after the reply had travelled laptop → phone and the phone had asked for audio (phone → laptop).
- **After:** as soon as Perceptron replies, the server runs the same filter the phone will run. If it's a new alert, it starts the ElevenLabs request immediately and buffers the audio; the phone's request picks it up (`startEarlySpeech()` / `takeEarlySpeech()`).
- **Measured** (reply reaching the phone → first audio byte, 6–7 real alerts):
  - **901 → 510 ms** with a simulated 150 ms hop each way
  - no difference with no network hop (all on one machine), as expected: the gain is the round trip it hides

### 10. Prefetch queue
- Every alert's audio starts generating the moment it's queued, even while earlier clips are still playing (`makeClip()` → `download()`).
- **Measured in simulation:** the next clip starts < 80 ms after the previous one ends; clips stay in order even when a later one finishes generating first.

### 11. Faster delivery
- v4 Turbo ignores `voice_settings.speed` (same 5.0 s clip at 1.0, 1.2 and 1.5) but follows an audio tag that isn't spoken aloud (checked by transcribing the output).
- **Measured, 3 alerts:**

  | Tag | Time |
  |---|---|
  | none | 10.16 s |
  | `[speaking quickly]` | 8.32 s |
  | `[fast-paced]` | 8.32 s |
  | `[speaking very quickly]` | 7.52 s |
  | **`[rapidly]`** | **7.44 s** (default) |

- **Faster but less natural option:** `ELEVENLABS_MODEL=eleven_flash_v2_5`, which speaks at speed 1.2: 6.46 s, with first audio ~170 ms. ElevenLabs rejects speeds above 1.2.

### 15. Stall watchdog
- With pause-while-speaking, a speech download that hung would have paused the camera forever.
- `speech.js` now gives up on a download that receives nothing for 8 s (`STALL_MS`), retries once, and moves on.

---

## Proximity sensor

### 16. Push instead of polling
- The ESP8266 POSTs each reading to `/distance`, and the server pushes it to every open phone over Server-Sent Events (`/api/distance/stream`). No polling delay.
- **Measured:** each reading arrives on the stream < 50 ms after the POST; 10 readings at the ESP's rate arrived in order.
- A replayed reading carries its age (`ageMs`), so old data is never treated as live, even if phone and laptop clocks differ.

### 17. Look-ahead beep scheduler
- `beeper.js` schedules beeps 150 ms ahead on the audio clock (checked every 50 ms), so timing stays steady even when the page is busy.
- The next beep is due one *current* interval after the last, so moving closer speeds the beeping up at once instead of after the old, longer gap.
- **Measured in simulation:** spacing within 5 ms of the target.

---

## Tried and rejected

| Idea | Result | Decision |
|---|---|---|
| Smaller frames (512 px, 384 px) | 170–250 ms faster, but at 512 px the room number "71A" was misread as "714" in 4/4 runs (768 px: correct 4/4) | Kept **768 px**. A deliberate cost for reading text |
| `regex` constrained output | +0.5–1 s, and the model stopped answering `n/a` | Not used |
| 2-frame motion clips (`video_frames`) | +~0.1 s; called static scenes "approaching" 3/3 times and misidentified cyclists | Off (`MOTION_FRAMES = false`) |
| Hard token cap on Low reasoning (400) | Similar speed to "think briefly", but 2/8 answers came back **empty** | Rejected |
| "Think briefly" on High | No effect (~1,560 thinking tokens regardless) | Only applied to Low |
| Trimming the system prompt | The whole prompt costs ~45 ms (893 vs 849 ms with a one-line prompt); each rule fixed a measured mistake | Kept |
| More than 3 requests in flight, or 8 at once in tests | 8 concurrent requests pushed latency to ~6 s | Kept 3 (+2 for hybrid reasoning) |
| 44.1 kHz audio | Refused by the current ElevenLabs plan (Pro tier needed) | 24 kHz |
| Streaming text replies | No measurable gain for 12-word replies | Removed |

---

## What limits speed now

1. **The model:** ~0.5–0.9 s per frame without reasoning. The scene change → alert floor is ~0.7–1.5 s.
2. **Phone ↔ laptop network:** check the diagnostics overlay (total vs model time). Early speech start hides one round trip for audio.
3. **Speaking time:** a 12-word alert still takes ~2–3 s to say. With pause-while-speaking on, the app doesn't look during that time.
4. **Sensor update rate:** the ESP sketch waits 200 ms per loop plus up to 250 ms for each HTTP POST, so readings come every 0.2–0.45 s. Shortening `delay(200)` and the HTTP timeout is the next easy win (not yet done).
5. **Not yet measured on a phone:** all numbers above come from the real APIs on a laptop, or from simulated browsers.
