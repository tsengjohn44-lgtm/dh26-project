# Testing process

How we check that a change works, step by step, and how to read the output. [testing.md](testing.md) lists what each suite covers and the calibration data. The scripts are in [`narrator/eval/`](../narrator/eval/README.md).

## The short version

```sh
node narrator/eval/run.cjs          # before committing: every offline check, ~1.5 min, free
node narrator/eval/api_eval.cjs     # after changing prompt.js or filter.js: real model, ~$0.01
```

Then try it on a phone. Some things can only be checked by walking with it (see the end of this page).

## Three layers

| Layer | What it answers | Cost | Command |
|---|---|---|---|
| **1. Offline suites** | Does the code do what we intended? Races, wiring, filters, payloads | free, ~1.5 min | `node narrator/eval/run.cjs` |
| **2. API eval** | Does the model, with our prompt, give good alerts? | ~40 requests, ~$0.01 | `node narrator/eval/api_eval.cjs` |
| **3. Real device** | Does it work in a hand, outdoors, on a real network? | a walk | phone + `node narrator/server.js` |

Plus **experiments** (`narrator/eval/experiments/`): one-off measurements behind specific decisions (stair counts, blur threshold, speech speed). They aren't run routinely; they're kept so every number in the docs can be traced to the script that produced it.

## Layer 1: offline suites

### What the runner does

`run.cjs` runs these steps in order and shows everything:

1. Prints a header: time, git commit (and whether there are uncommitted changes), Node version.
2. **Syntax check:** `node --check` on `server.js`, `prompt.js` and every file in `public/`.
3. **Each suite in its own Node process**, one after another. Every check prints one line as it runs. Real output, with the stair-count discount deliberately broken (`--quiet` hides the `✓` lines):
   ```
   ── filter_prompt  (suites/filter_prompt_test.cjs)
      filter.js repeat/n-a rules, stair count and label; prompt.js payloads and sensor paragraph
     ✗ cautiousStairCount: 3 → 2 steps   Stairs going up ahead, at least 3 steps.
     ✗ cautiousStairCount: 2 → "1 step" (plural fixed)   Stairs up, at least 2 steps.
     ✗ classifyReply applies the discount to new alerts   Stairs going down ahead, at least 8 steps.
     42/45
   ```
   A `✗` line ends with the actual value, so you can see what went wrong without opening the test.
4. For `distance_server`, it starts the real `server.js` on spare ports (18080 / 18443 / 15000), so a server you already have running is left alone, and stops it afterwards.
5. **Summary table** and an overall result:
   ```
   suite            result  passed failed    time  note
   syntax           PASS         9      0    0.0s
   filter_prompt    PASS        45      0    0.0s
   app              PASS       115      0   52.5s
   …
   ALL PASSED: 292 checks passed, 0 failed
   ```
6. Saves the full transcript to `narrator/eval/results/<time>.log`.

A suite **passes** only if it exits normally, prints no `✗`, and ends with a `pass/total` line that matches what was counted. A suite that crashes partway, hangs (3-minute limit), or prints nothing fails. A missing check can't count as a pass. The exit code is 0 only if everything passed.

Options: `--list` (what each suite covers), `--only app,beeper` (run some), `--quiet` (show only failures and the summary), `--api` (add the API eval at the end).

### How the suites work without a phone

There's no phone, Chrome or other headless browser on the development laptop, and the project has no npm dependencies. So the suites load the **real source files** and supply fakes for what a browser provides:

- **Fake browser** (`app_test`, `ui_test`, `history_ui_test`): the real `app.js` / `ui.js` runs in a Node `vm` context with fake `document` elements, camera streams, screen orientation, motion sensors, `fetch`, `localStorage` and timers. A test can then, for example, tap Stop while the camera is still opening and check that the camera was closed.
- **Fake audio clock** (`speech_*`, `beeper_test`): fake `fetch` streams deliver PCM chunks on a schedule, and a fake Web Audio context records when each sound would start and stop. That lets a test check ordering, gaps and overlaps exactly.
- **Synthetic signals** (`recorder_test`): generated speech-like audio with pauses, clicks and background noise.
- **Plain functions** (`filter_prompt_test`): `filter.js` and `prompt.js` are called directly.
- **Real server** (`distance_server_test`): actual HTTP requests to `server.js`.

These catch logic errors, races and regressions in seconds. They can't tell whether the model's answers are good (layer 2), or whether the phone's hardware behaves as the fakes assume (layer 3).

### Checking that a suite can fail

When adding a check, break the code on purpose once and confirm the check goes `✗`. For example, setting `STAIR_COUNT_FACTOR = 1` in `filter.js` makes 3 checks in `filter_prompt` fail, and the run exits 1. Then restore the code. A check that can never fail proves nothing.

## Layer 2: API eval

`api_eval.cjs` sends 19 test photos to Perceptron **exactly as the server does** (`prompt.js` `buildPayload`). It filters each reply **exactly as the phone does** (`filter.js` `classifyReply`, including the stair-count discount and label fix), so it grades what the user would actually hear.

For each photo:

| Check | Rule |
|---|---|
| ≤ 12 words | output rule |
| no distances | no "3 m", "10 feet", … (user requirement) |
| step count only for stairs | "N steps" only in a stairs alert |
| label | the expected hazard label: `trip` / `drop` / `none` (photos marked `any` are shown but not graded) |
| not spoken twice | the same photo again, with its own alert in "Already said", gives `n/a` or a filtered repeat |

It prints every reply ("heard", plus "model" when the filter changed it), then median and worst latency, and saves all replies to `results/<time>-api.json`.

Options: `--runs 3` (each photo several times; the model varies), `--reasoning low|high`, `--style classic`.

### Reading the result

**The API eval is a measurement, not a pass/fail gate.** The model's answers vary from run to run, and some photos are genuinely hard. Compare runs; don't aim for 100%.

Baseline on 2026-10-18 (safety prompt, reasoning off, 1 run): **84/88**, median 1.08 s, worst 2.09 s. The 4 misses were known weaknesses:
- `stairs/down2` is side-on and read as going up (also seen in the stairs evaluation, AGENTS.md section 7).
- `open2/door_open_doorway`: a real step at a doorway labelled Trip hazard. That's arguably right; the photo's expectation may be too strict.
- `open2/open_wide_archway`: a statue called an obstacle; on a second look the model reported people ahead (new content, so not a filter bug).

### Changing the prompt: the procedure

1. **Run before.** `node narrator/eval/api_eval.cjs --runs 2` on the current prompt. Keep the `results/*-api.json` file.
2. Change `prompt.js`. Save a copy of the old version in `narrator/eval/baselines/` if it's a meaningful step.
3. **Run after, in the same session.** Perceptron latency varies between sessions (Low reasoning measured 1.3 s median one day, 2.1 s another), so only same-session numbers are comparable.
4. **Compare both directions.** Check that the targeted case improved, and also that unrelated photos didn't get worse. Example: adding the distance-sensor paragraph fixed obstacle detection but mislabelled stairs going down, which only showed up on the unrelated stair photos.
5. **Test contradictions** when the change adds context (a sensor reading, a history): give context that disagrees with the picture. That's when the model invents things (9/12 invented obstacles before the sensor wording fix).
6. **Keep the examples generic.** The model copies example phrases word for word.
7. **Write down the numbers** in AGENTS.md section 7 (decision + measurement) and the relevant `docs/` page, with the method.

Rules for any real-API measurement:
- At most ~3 requests at once. With 8 at once, latency rose to ~6 s and the results were distorted. `api_eval.cjs` uses 3.
- Report the median and the worst case, not one run.
- Build requests with `buildPayload`, never by hand, so the test sends what the app sends.

## Layer 3: real device

On the phone, the 🐞 diagnostics overlay and the 🕘 History sheet are the test tools:
- **🐞 overlay:** last frame sent, total vs model latency, blur verdict, camera rotation, gravity, orientation events.
- **🕘 History:** every model reply and what happened to it (spoken, repeat, n/a, too late), copyable as text.

Still unverified, and only checkable on a device: real motion blur and low-light noise, the Android flip tipping point, ultra-wide lens selection, fullscreen/portrait lock across browsers, how speech and beeps sound, the swipe-to-close gesture, vibration, phone↔laptop network delay, and ESP8266 power on battery. Each system doc lists its own items under "Not yet confirmed on a phone".

## Where the evidence lives

| What | Where | In git |
|---|---|---|
| Suites, runner, API eval | `narrator/eval/` | yes |
| Experiment scripts behind past decisions | `narrator/eval/experiments/` (indexed in its README) | yes |
| Earlier prompt versions | `narrator/eval/baselines/` | yes |
| Test photos | `narrator/eval/photos/` | no: kept on disk, out of git for size and licensing |
| Run transcripts and API replies | `narrator/eval/results/` | no: copy a file elsewhere if a doc cites it |
| Measured numbers and the decisions they support | `AGENTS.md` section 7, `docs/*.md` design-decision tables, `docs/optimization.md` | yes |

## Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| **One runner, each suite in its own process** | One crashing or hanging suite can't take down or hide the others; the summary shows exactly which failed and why. | One process requiring every suite (a crash stops everything); a test framework (adds dependencies). |
| **Every check printed by name** | Anyone can read what was tested, not just a count. A failure shows the actual value next to the check's name. | Silent on success. |
| **Suite fails without its `pass/total` line** | A crash halfway would otherwise look like "0 failures". | Counting only `✗`. |
| **Transcripts saved per run** | A result can be checked later or shared, together with the commit it ran on. | Terminal output only. |
| **API eval separate from the default run** | It costs money, needs the key and network, and its results vary; offline checks must be free and deterministic so they can run on every change. | Running the model on every check. |
| **API eval grades what the user hears** | The filter changes replies (stair counts, labels, repeats), so grading raw model text would test something the user never gets. | Grading raw replies. |
| **Experiments kept as run, not rewritten** | Rewriting them would change what was measured. Kept as is, each documented number points to its exact script. | Deleting one-off scripts after use (how it was done before; they lived in a temporary folder). |
