# Vision: camera → Perceptron → alert

Code: `narrator/public/app.js`, `narrator/public/filter.js`, `narrator/prompt.js`, and `describe()` in `narrator/server.js`.

## 1. Camera

- **Widest view** (`openCamera`, `useWidestLens`):
  - asks for 1920×1440 at **4:3**, which uses the whole sensor on most phones (16:9 crops it)
  - picks an ultra-wide lens when the browser lists one ("Back Ultra Wide Camera" on iPhone), otherwise the lowest zoom if below 1×
  - most Android browsers expose neither, so they get the 4:3 gain only
- **Frames** (`grabFrame`): scaled to ≤768 px, JPEG quality 0.7. 768 rather than 512, because 512 px misread room numbers (see [optimization.md](optimization.md)).
- **Camera reopen safety:**
  - `cameraToken` closes a camera that finishes opening after Stop or a newer reopen, so the camera light never stays on
  - `reopenCamera()` reopens one at a time
  - `grabFrame()` returns nothing while no camera is attached
- **Android upside-down image:**
  - With the phone flat or aiming at the ground (top edge below bottom edge), Android Chrome and Edge turn the camera image 180° and report it nowhere.
  - The app predicts this from the gravity sensor (`updateFrameTurn`, y < −0.5 on, > +0.5 off) and turns the preview and the frames sent to the AI back upright. Android only.
  - Phones also go fullscreen with the screen locked to portrait on Start, and 180° screen turns reopen the camera.
  - The tipping point is an assumption. The diagnostics overlay logs every flip it sees in the picture, to check it.

## 2. Blur gate (`pickFrame`)

Blurry frames give wrong answers (tested: lost room numbers, a halved stair count, invented "cars approaching"), so they aren't sent.

- **Sharpness:** `Filter.sharpness()` measures edge strength (variance of the Laplacian) on a 160×120 grayscale copy, divided by brightness² so shade doesn't look like blur.
- **Relative threshold:**
  - blurry when below **0.5×** the 90th percentile of recent scores (8 s) from the **same view**
  - a new view starts a fresh reference, because a sharp blank wall scores low
  - with fewer than 4 scores, every frame counts as sharp
- **Gyroscope:** turning faster than 90°/s counts as blurry.
- **Flow:**
  - a blurry frame is skipped, and the next is checked 100 ms later
  - after 2 s with nothing sharp, the sharpest is sent
  - after 3 s of blur, the voice says "Hold the phone steady." (at most every 15 s)

## 3. View change (`checkViewChange`, `Filter.viewChange`)

- 1 − correlation between 24×18 grayscale thumbnails of this frame and the first frame of the current view. Above **0.5** starts a new view:
  - "already said" is cleared
  - the old alert moves to history
  - the card shows "Looking…", then "Nothing important in view." if the model has nothing to report
- Two featureless frames (black or blank) count as the same view. Without this, a covered lens repeated alerts.
- **Calibrated on photos:** 0/46 false resets from shake or exposure; 240/253 real scene changes detected.

## 4. Scheduling (`loop`, `sendFrame`)

- A new frame every `interval` (0.3–3 s, default 0.4 s), with up to **3** requests in flight. Replies older than one already handled are dropped. Each request has a 20 s timeout (30 s with reasoning).
- **Pause while speaking** (Settings, on by default): no new frames while an alert is spoken or queued.
- **Errors and rate limits:** 429/503 → pause for `Retry-After` or at least 2 s.

## 5. The request (`prompt.js` `buildPayload`)

```js
{ model: 'perceptron-mk1.5', stream: false, temperature: 0.2,
  reasoning_effort: 'none' | 'low' | 'high',
  max_completion_tokens: 40 /* 2048 with reasoning */,
  messages: [ system: SYSTEM_PROMPT (+ "think briefly" for Low),
              user: [ image (data URL), "Already said (oldest first): …  What is new and important now?" ] ] }
```

**Two prompt styles** (Settings → Vision → **Safety labels**, saved on the phone; the request carries `style: 'safety' | 'classic'`):
- **Safety labels on** (default): `SYSTEM_PROMPT`, e.g. "Trip hazard: curb edge, ahead."
- **Off:** `CLASSIC_PROMPT`, the earlier prompt kept unchanged, e.g. "Curb close ahead, left."

Both share the same rules for focus, stairs, doors, repetition and `n/a`. With classic replies there are no labels, so hazard alerts don't jump the speech queue. The filter handles both styles.

**The system prompt** (safety-first since 2026-10-18), in summary:
- **Role:** the eyes of a blind pedestrian; speak only when it matters.
- **Focus:** what is directly ahead (frame centre, the ground about to be walked on); ignore edges and distance unless something is moving toward the person.
- **Safety first:** name the single most dangerous thing first; if 12 words aren't enough, keep the safety warning.
- **Every hazard starts with one label:**

  | Label | For |
  |---|---|
  | `Trip hazard:` | curbs, steps or stairs going up, uneven ground, potholes, cables, objects on the floor |
  | `Drop-off:` | stairs going down, platform or curb edges, holes, sudden drops |
  | `Head hazard:` | anything at head height in the path: branches, signs, overhangs, open cabinet doors |
  | `Moving hazard:` | vehicles, bikes or people moving toward them |
  | `Obstacle:` | something in the path at body height: poles, bins, a person standing |

- **Stairs:** the direction decides the label. Up → `Trip hazard: stairs going up …`, down → `Drop-off: stairs going down …`, always with "at least N steps".
- **No label** for navigation cues (doors, crosswalks, intersections, elevators) and large readable text, which are still reported when there's no hazard.
- **Be certain:** report only what's clearly visible. "Door" only for a real door, not an opening.
- **Style:**
  - ≤12 words including the label, one line, `<Label>: <what>, <where>.`; left/ahead/right, "close" within about 2 steps
  - no distances, except stairs: always up or down plus a cautious "at least N steps"
  - list signs in one alert
- **Repetition:** don't restate what's in "Already said"; a new place is new.
- **Nothing important:** reply exactly `n/a`.

Every rule fixed a measured problem; see the decisions table in `AGENTS.md`. The examples are **templates** (`Trip hazard: <object>, <where>.`), because the model copies concrete examples word for word. A first version that only had a stairs-*down* template turned a stairs-up photo into "Drop-off: stairs going down", so there is now one stairs template for each direction.

**Measured, old vs safety-first prompt** (19 photos × 2 runs, same session):
- hazard photos labelled: 0/18 → **18/18**
- correct label overall: 16/34 → **29/34**
- stairs up → "Trip hazard: stairs going up…" in 5/6; stairs down → "Drop-off…" 4/4
- 3 labels on photos expected to have none, all plausible ("step up to door", "statue close on left")
- 0 replies over 12 words; median time 609 → 639 ms
- **Regressions:** an aerial crosswalk photo and distant cyclists came back `n/a` instead of being reported

### Distance sensor context (`sensor`, optional)

When Settings → Proximity sensor → **Share distance with AI** is on (default) and the ESP8266 has a valid reading, each request carries `sensor: { distanceM, heightM }`. This applies to narration, the Fast + Low reasoning request and spoken questions.
- **Valid** means all of these (`Beeper.reading`): a number, not `Out_of_Range`; between 2 cm and 4 m; at most 1.5 s old. Otherwise the field is left out and the request is exactly as before.
- **`heightM`** is Settings → **Sensor height** (0.1–2 m, default 1 m), so the model knows what the beam can hit.
- **Server:** `prompt.js` `cleanSensor` checks the ranges again (distance 0.02–4.5 m, height 0–3 m) and `sensorText` adds one paragraph to the **user** message. The system prompt is unchanged, so it stays identical between requests, and requests without a reading are unaffected.
- **What the paragraph says:**
  - the sensor's mounting height and reading
  - the person already hears this distance as beeps
  - use the reading only to confirm that something in the **center** of the frame is close (within ~1.5 m)
  - if nothing there looks that close, ignore the reading: never attribute it to objects at the sides or farther away, never invent an object
  - it says nothing about the ground: curbs, steps and holes can be close even when the reading is far
  - **never say the number** (for spoken questions: only if the question asks how far, and roughly)

**Measured** (real API, 2026-10-18, same session, sensor at 1 m):
- **Numbers spoken: 0** in every reply with a reading (over 40 replies).
- **Latency:** unchanged (medians 395–461 ms without vs 438–449 ms with, across three runs: noise).
- **Real close obstacle** (construction fence, reading 0.9 m): "Obstacle: fence close ahead." 4/4 with the reading, vs 1/2 without (the other was `n/a`).
- **Contradicting readings** (reading 0.6 m on open views with nothing near: corridor, parking lot, street, concourse):
  - first wording: **9/12 invented "close" obstacles**, e.g. "Obstacle: car close ahead." for a car across the street, "glass wall close ahead" for a wall at the side
  - after the "center only, otherwise ignore" wording: **1/12** (the street car, once)
  - In real use the reading usually agrees with the scene; a disagreement means something the camera can't see (glass, a hand, a tilted phone hitting the floor), and then saying nothing is right.
- **Ground hazards** (reading 3.5–4 m, i.e. the beam passes over them): stairs unchanged 4/4. The curb was called "close" in 2/4 runs with the reading vs 3/4 without, and the pothole was missed once in 4 (0 without): within noise, but worth watching.
- **Side effect found and fixed:** with the paragraph, stairs going down were labelled "Trip hazard" in 7/16 replies (0/8 without). `filter.js` `fixStairLabel` now enforces the direction rule in code (below).

## 6. Reasoning modes (Settings → Vision → Reasoning)

| Mode | What it sends | Typical time per frame | Notes |
|---|---|---|---|
| **Off** (default) | `none`, cap 40 | ~0.5 s | best for walking |
| **Fast + Low** | each frame twice: `none` (alert) and `low` (`sendSlow`) | alert ~0.5 s, correction ~1–1.5 s later | the reasoning reply is shown only if it adds or corrects something; ≤2 reasoning requests at once |
| **Low** | `low` + "think briefly", cap 2048 | ~1.35 s median, outliers 3–6 s | better details (e.g. a sign's arrow direction) |
| **High** | `high`, cap 2048 | ~5 s | most thorough, too slow for walking |

## 7. Filtering replies (`filter.js`)

`classifyReply(raw, said, { refine })` returns `{ text, reason }`:
- **`n/a` / "No change."** → nothing shown.
- **Repeat:** at least 60% of the reply's content words already appear in an alert said for this view.
  - **Content words** ignore filler (ahead, sign, close, steps, …) and stair counts, and keep up/down.
  - **Counted as new anyway:**
  - a new number (Room 214 → 215)
  - a hazard that has become "close"
  - **safety escalation:** a hazard label the matching earlier alert lacked ("Curb ahead" → "Trip hazard: curb close ahead"), for fast and Fast + Low replies alike
  - with `refine` (Fast + Low reasoning replies), a new direction word (arrow left → right)
- **Labels and comparison:** the hazard label is removed before comparing words, so "Trip hazard: curb" vs "Trip hazard: step" stays new. An alert that is nothing but label and filler (e.g. "Trip hazard: step ahead.") repeats only an equally bare alert with the same label. `Filter.hazardLabel(text)` returns `trip | drop | head | moving | obstacle | null`.
- **Stair counts** are multiplied by 0.75 and rounded down (`cautiousStairCount`), because the model overcounts short flights. Underestimating is safer.
- **Stair labels** (`fixStairLabel`): the direction decides the label, enforced in code. "Trip hazard: stairs going down" becomes "Drop-off: stairs going down", and the reverse for stairs going up. It is left alone when both or neither direction appears. Applied before the repeat check, and to spoken-question answers (phone and server's early speech alike). 9 unit checks.

## 8. Perceptron facts that matter here

- Model `perceptron-mk1.5`; the Isaac models are retired. Endpoint `POST https://api.perceptron.inc/v1/chat/completions`, OpenAI-style.
- **`max_completion_tokens`** is the output cap. `max_tokens` is silently ignored.
- Reasoning tokens count toward that cap. With a cap of 40, reasoning returns empty answers.
- **Stateless.** The rate limit is 300 requests/min per organization. Base64 data-URL images are accepted.
- Image size matters more than prompt length: a 768 px frame is ~730 input tokens in total, and the whole prompt costs only ~45 ms.

## Design decisions

| Decision | Why | Rejected alternative / evidence |
|---|---|---|
| **4:3 at 1920×1440, widest lens** | A blind walker needs the widest view of the path. 4:3 uses the whole sensor on most phones; ultra-wide where the browser exposes it. | 16:9 crops the top and bottom, which is where the ground and head-height hazards are. |
| **Frames at 768 px, JPEG 0.7** | Small enough to be fast, big enough for signs. | 512 px misread "71A" as "714" in 4/4 runs, for only ~170 ms saved. |
| **Blur gate with a relative threshold** | Blurry frames gave wrong answers (lost room numbers, halved stair counts, invented cars). Sharpness depends hugely on the scene (186 for a parking lot, 4,795 for an atrium), so the threshold is relative to recent frames of the same view. | A fixed threshold would skip every frame of a plain wall and none of a busy street. |
| **Send the sharpest frame after 2 s anyway** | Never leave the user blind for long; a slightly blurry answer beats none. | Waiting indefinitely for a sharp frame. |
| **View change from 24×18 thumbnails** | Cheap enough for every frame (no API call). Correlation ignores exposure changes, so walking under shade doesn't reset. | Asking the model whether the scene changed: a second request per frame. Calibrated: 0/46 false resets, 240/253 real changes. |
| **Up to 3 requests in flight, every 0.4 s** | The model takes ~0.5–0.9 s; overlapping requests cut scene-change → alert from 1.5–1.7 s to 0.7–1.5 s. 3 at once took about as long as 1. | One at a time (slow); more than 3 (8 at once inflated latency to ~6 s, and nears the 300/min rate limit). |
| **Single frames, not 2-frame clips** | With clips the model called static scenes "approaching" 3/3 times. | Motion clips (code kept behind `MOTION_FRAMES = false`). |
| **No streaming of replies** | Replies are a few words, and the whole reply is needed to filter repeats. | Streaming: saves ~0.1 s, complicates filtering. |
| **`temperature: 0.2`** | Fewer rewordings of the same scene, which would slip past the repeat filter. | Default temperature. |
| **Hazard labels, safety first** | A blind walker must know at once that an alert is a danger and what kind. Labelled hazards also jump the speech queue. | Plain priority list (kept as the "classic" style): 0/18 hazard photos labelled vs 18/18. |
| **Template examples, never concrete ones** | The model copies concrete examples word for word (an example "crosswalk beyond it" appeared on photos with no crosswalk). | Concrete examples. |
| **`n/a` when nothing new** | Silence is information too; talking constantly hides the important alerts. | Always describing the scene. |
| **"Already said" limited to the current view, ≤5 alerts** | Enough to stop repeats; a new view starts fresh, so new places are always announced. | Global history: the model refused new places ("never mention again" made it answer `n/a` to a crosswalk after stairs). |
| **Repeat filter in code as well as in the prompt** | The model still restates things in other words; 60% content-word overlap catches that, with exceptions for things that matter (a new number, "close", a new hazard label). | Trusting the prompt alone. |
| **Stair count ×0.75 and stair labels fixed in code** | Both are safety rules the model breaks sometimes (overcounting short flights; mislabelling direction). Code enforces them every time. | Prompt wording alone did not fix either. |
| **Reasoning off by default; Fast + Low for corrections** | Off is ~0.5 s; Low is ~1.35 s with 3–6 s outliers, too slow as the only path while walking. Fast + Low keeps the quick alert and lets the slower reply correct it (e.g. a sign's arrow direction). | Low or High by default. |
| **Sensor reading in the user message, not the system prompt** | It changes every frame; the fixed system prompt stays identical between requests, and requests without a reading are unchanged. | Changing the system prompt per request. |
| **Sensor reading only confirms what is visible** | The first wording made the model blame the reading on any object (9/12 invented "close" obstacles). The user hears the distance as beeps already, so the model's job is only to say *what* is close. | Letting the model trust the reading over the picture. |

## Not yet confirmed on a phone

- the blur thresholds with a real camera
- the Android flip tipping point
- ultra-wide lens selection
