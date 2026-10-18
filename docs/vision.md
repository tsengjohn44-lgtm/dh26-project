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

## 8. Perceptron facts that matter here

- Model `perceptron-mk1.5`; the Isaac models are retired. Endpoint `POST https://api.perceptron.inc/v1/chat/completions`, OpenAI-style.
- **`max_completion_tokens`** is the output cap. `max_tokens` is silently ignored.
- Reasoning tokens count toward that cap. With a cap of 40, reasoning returns empty answers.
- **Stateless.** The rate limit is 300 requests/min per organization. Base64 data-URL images are accepted.
- Image size matters more than prompt length: a 768 px frame is ~730 input tokens in total, and the whole prompt costs only ~45 ms.

## Not yet confirmed on a phone

- the blur thresholds with a real camera
- the Android flip tipping point
- ultra-wide lens selection
