# User interface

Code: `narrator/public/index.html`, `style.css`, `ui.js` (behaviour), `app.js` (logic). Redesigned 2026-10-18: clean, one main action, no sub-menus.

## Main screen

```
┌──────────────────────────────┐
│ ● Live · 0.8 m     🕘  ⚙  ⇄  │  status pill · History · Settings · switch camera
│                              │
│        (camera, full)        │
│ ╭──────────────────────────╮ │
│ │ Stairs going down ahead, │ │  alert card (amber edge = hazard)
│ │ at least 6 steps.        │ │  tap to hear it again
│ ╰──────────────────────────╯ │
│   Door on right · Curb close │  last 2 alerts, faded
│   🔊        ( STOP )      📳  │  Voice · Start/Stop · Beeps
└──────────────────────────────┘
```

- **Status pill** (`#status`, `#distance`): a red pulsing dot when live.
  - States: Idle, Starting…, Live, Live · new view, Live · nothing new, Live · already said, Live · paused while speaking, Live · hold steady (blurry), Error.
  - Sensor badge: "obstacle 0.42 m", "sensor: clear" or "sensor offline".
- **Alert card** (`#current`): large text (24–32 px depending on width).
  - The amber left edge marks hazards: stairs, steps, curb, drop, hole, close, car, bike, cyclist, vehicle, approaching.
  - Android phones vibrate for 40 ms on each new alert, and new alerts slide in.
  - **Tap or press Enter to hear it again.**
- **Recent alerts** (`#history`): the last two alerts, faded. The app keeps four; CSS shows two. **Tap them to open the full History.**
- **Bottom bar:** Voice (`#voice`), **🎤 Ask** (`#ask`: tap once and speak, and the question is sent when you stop talking; tapping again sends at once, and holding sends on release; pulses red while listening; see [questions.md](questions.md)), Start/Stop (`#start`, 88 px, red while running), Beeps (`#beeps`).
- **⇄** (`#flip`): switches between the front and rear cameras.

## History (🕘 → bottom sheet)

Every Perceptron reply, and what the app did with it, is kept **on the phone** (`log.js`, `localStorage` key `replyLog`), across reloads. Nothing is stored on the server.
- **Kept:** the last **1,000** entries (about 50–150 KB). Each has a time, a kind, the text and, for model replies, how long it took.
- **Kinds:**
  - spoken: `alert`, `correction` (Fast + Low reasoning reply that was shown), `answer` (🎤 Ask), `hint` ("Hold the phone steady.")
  - dropped: `repeat` (already said), `n/a` (nothing new), `late` (overtaken by a newer frame or a view change), `error`
  - Spoken entries hold the text as shown (stair count and label corrected); dropped ones hold the model's raw reply.
- **The sheet** (`#logSheet`, opened by `#historyBtn` or by tapping the recent alerts):
  - **Spoken / All replies** filter (remembered as `logFilter`). All replies adds the dropped ones, dimmed, with their time taken.
  - Newest first; hazards marked with the amber edge; new replies appear live while it's open. 300 rows at a time, then **Show older**.
  - **Tap a row** to hear it again.
  - **Copy**: the list as plain text (date, time, kind, text, ms), for sharing or checking the prompt. Falls back to a text selection where the clipboard API isn't available (plain HTTP).
  - **Clear**: deletes the history after a confirmation.
- Saving is debounced (at most once a second) and forced when the page is hidden or closed.

## Settings (⚙ → bottom sheet)

One scrolling list. It closes with ✕, a tap outside, Escape, or a swipe down on the handle.

| Section | Control | Default |
|---|---|---|
| Speech | Interrupt (`#interrupt`): new alerts cut off the one being spoken | off |
| Speech | Pause while speaking (`#pauseSpeaking`): don't send frames while speaking | on |
| Vision | Safety labels (`#safetyLabels`): hazard labels on, or the earlier plain style | on |
| Vision | Reasoning: Off · Fast+Low · Low · High (four buttons driving the hidden `#reasoning` select) | Off |
| Vision | Frame every (`#interval`): 0.3–3 s | 0.4 s |
| Proximity sensor | Beep volume (`#beepVolume`) | 60% |
| Proximity sensor | Intensity (`#beepIntensity`): 0.5–2× | 1.0× |
| Proximity sensor | Share distance with AI (`#sensorToAi`): add the sensor reading to each request | on |
| Proximity sensor | Sensor height (`#sensorHeight`): 0.1–2 m, how high the forward sensor is mounted | 1.00 m |
| Diagnostics | Diagnostics overlay (`#debugBtn`) | off |

All settings are saved on the phone (`localStorage` keys: `voice`, `interrupt`, `pauseWhileSpeaking`, `safetyLabels`, `reasoning`, `beeps`, `beepVolume`, `beepIntensity`, `sensorToAi`, `sensorHeight`, `debug`; History uses `replyLog` and `logFilter`).

## Diagnostics overlay (`#debug`)

For testing on a device. It shows:
- **Timing:** total / model time per frame (`#latency`), the camera in use (`#lens`), speech start time and queue (`#voiceStatus`)
- **Frames:** a thumbnail of the exact frame sent to Perceptron, and the version label (`VERSION` in `app.js`; fixed, to confirm the phone has the latest code)
- **Orientation:** screen orientation, fullscreen and portrait-lock result (with the exact error if refused), the camera frame's rotation tag, how the phone is held, flip correction on/off, and the last 8 orientation, flip and lock events
- **Blur:** verdict, sharpness vs threshold, skip count, turn rate
- **Sensor → AI:** the distance and height sent with each frame, or why nothing is sent (off, sensor offline, out of range)
- **Fast + Low:** reasoning reply time, and how many were spoken, suppressed or too late

## How it's built

- **History:** `log.js` stores (`window.Log`); `app.js` calls `logReply()` at each decision point (`handleReply`, `handleSlowReply`, the Ask answer, the blur hint, request errors); `ui.js` renders the sheet. Without `log.js` the app runs unchanged.
- **Element IDs used by `app.js` stayed the same** through the redesign. `app.js` holds the logic; `ui.js` only adds interface behaviour:
  - opening and closing the sheet
  - the segmented control, which sets the select and dispatches `change`
  - tap-to-repeat
  - hazard highlight and vibration, via a `MutationObserver` on the card's `data-alert`
- If `ui.js` fails, every control still works as a plain form control.
- **Styling:**
  - dark theme with CSS variables and one amber accent
  - frosted panels (`backdrop-filter`, with a solid fallback); the sheet is fully opaque so the alert never shows through
  - a top and bottom scrim over the camera for contrast
- **Phones:** in fullscreen with the screen locked to portrait while running (Android); see [vision.md](vision.md).

## Accessibility

- Tap targets ≥ 48 px (Start is 88 px).
- The caption is an `aria-live="polite"` region, so new alerts are announced by screen readers. The card is focusable with a label ("Current alert. Tap to hear it again.").
- Every control has a visible or screen-reader label. The sheet is a labelled dialog with focus management, and the segmented control is a `radiogroup`.
- Nothing is conveyed by colour alone: hazards are also in the text and spoken.
- All animation is turned off under `prefers-reduced-motion`.
- Safe-area insets are respected; layout checked at 360 and 412 px.

## Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| **One main action (Start), everything else secondary** | The user is blind or low-vision: the screen must be usable by feel and with a screen reader. One big button in a fixed place, the three quick toggles beside it. | Several equal buttons; menus. |
| **Settings in one scrolling sheet, no sub-menus** | Few settings, rarely changed; one list is easier to navigate with a screen reader than nested pages. | A settings page with sections; tabs. |
| **Alert card large, with tap-to-repeat** | Low-vision users read the big text; blind users hear it, and can tap anywhere on the card to hear it again if they missed it. | Small captions; a separate repeat button. |
| **Last two alerts visible, faded** | Context for a sighted helper or low-vision user, without competing with the current alert. | Full history list. |
| **Amber edge + vibration for hazards** | A second channel besides speech; nothing relies on colour alone (the label is in the text and spoken). | Colour-coded text only. |
| **Dark theme, one accent colour** | Maximum contrast over a camera image, low glare outdoors at night, and the accent always means "hazard" or "active". | Light theme; several accent colours. |
| **Behaviour in `ui.js`, logic in `app.js`, element IDs unchanged** | The redesign couldn't break the tested logic: `app.js` kept all its IDs and its fake-browser tests passed unchanged. If `ui.js` fails, the controls still work. | Rewriting the app around a new UI. |
| **Segmented control drives a hidden `<select>`** | Four visible buttons are faster than a dropdown on a phone; the select keeps `app.js` unchanged and saves the choice. | Replacing the select in `app.js`. |
| **Diagnostics hidden behind a switch** | Timing, orientation and blur details were essential for debugging on a phone, but clutter the screen for users. | Always visible; removed. |
| **Settings saved per phone (`localStorage`)** | No accounts; each phone keeps its own preferences across reloads. | Server-side settings. |
| **History kept on the phone, not the server** | Each phone has its own walk; no accounts, works offline, nothing about where the user walked leaves the device. `localStorage` survives reloads. | A server log (shared, needs storage and privacy decisions). |
| **Capped at 1,000 entries** | About an hour of walking at typical rates, well under the ~5 MB storage limit, and the list stays fast to open. | Unlimited (fills storage, slow). |
| **Dropped replies kept too ("All replies")** | Checking why something *wasn't* said is the main debugging need on a walk: was it `n/a`, a repeat, or late? | Logging only spoken alerts. |
| **Debounced saves** | Replies arrive 2–3 a second; writing the whole log each time would be wasteful on a phone. Saved at least once a second and when the page is hidden, so at most ~1 s can be lost. | Saving on every reply. |
| **History as a second sheet, same behaviour as Settings** | Nothing new to learn; ✕, backdrop, Escape and swipe-down work the same, and only one sheet is open at a time. | A separate page (loses the camera and narration). |
| **Sensor height as a slider with a live value** | Easy to set once by feel, readable by screen readers through the `<output>`. | A free-text number field. |

## Checking the layout without a phone

macOS Quick Look renders HTML with WebKit:
1. Make a static copy of `index.html` with the scripts removed and sample content in place.
2. To see the sheet open, disable animations in the copy. Quick Look snapshots the first frame, before the sheet slides in.
3. Put the copy in iframes 360 and 412 px wide.
4. Run `qlmanage -t -s 1000 -o . preview.html`.

This found the see-through sheet bug.
