# User interface

Code: `narrator/public/index.html`, `style.css`, `ui.js` (behaviour), `app.js` (logic). Redesigned 2026-10-18: clean, one main action, no sub-menus.

## Main screen

```
┌──────────────────────────────┐
│ ● Live · 0.8 m        ⚙  ⇄  │  status pill · Settings · switch camera
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
- **History** (`#history`): the last two alerts, faded. The app keeps four; CSS shows two.
- **Bottom bar:** Voice (`#voice`), Start/Stop (`#start`, 88 px, red while running), Beeps (`#beeps`).
- **⇄** (`#flip`): switches between the front and rear cameras.

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
| Diagnostics | Diagnostics overlay (`#debugBtn`) | off |

All settings are saved on the phone (`localStorage` keys: `voice`, `interrupt`, `pauseWhileSpeaking`, `safetyLabels`, `reasoning`, `beeps`, `beepVolume`, `beepIntensity`, `debug`).

## Diagnostics overlay (`#debug`)

For testing on a device. It shows:
- **Timing:** total / model time per frame (`#latency`), the camera in use (`#lens`), speech start time and queue (`#voiceStatus`)
- **Frames:** a thumbnail of the exact frame sent to Perceptron, and the version label (`VERSION` in `app.js`; fixed, to confirm the phone has the latest code)
- **Orientation:** screen orientation, fullscreen and portrait-lock result (with the exact error if refused), the camera frame's rotation tag, how the phone is held, flip correction on/off, and the last 8 orientation, flip and lock events
- **Blur:** verdict, sharpness vs threshold, skip count, turn rate
- **Fast + Low:** reasoning reply time, and how many were spoken, suppressed or too late

## How it's built

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

## Checking the layout without a phone

macOS Quick Look renders HTML with WebKit:
1. Make a static copy of `index.html` with the scripts removed and sample content in place.
2. To see the sheet open, disable animations in the copy. Quick Look snapshots the first frame, before the sheet slides in.
3. Put the copy in iframes 360 and 412 px wide.
4. Run `qlmanage -t -s 1000 -o . preview.html`.

This found the see-through sheet bug.
