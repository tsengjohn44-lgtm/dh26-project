# narrator/eval: tests and measurements

How and why we test is explained in [docs/testing-process.md](../../docs/testing-process.md). This file is the index of what's here.

```sh
node narrator/eval/run.cjs            # every offline check, ~1.5 min, no API calls
node narrator/eval/run.cjs --list     # what each suite covers
node narrator/eval/api_eval.cjs       # real Perceptron calls on test photos (~$0.01)
```

| Path | What | In git |
|---|---|---|
| `run.cjs` | Runner: syntax check, then each suite in its own process; prints every check, a summary table, and saves a transcript to `results/` | yes |
| `api_eval.cjs` | Maintained prompt evaluation against the real API | yes |
| `suites/` | Offline suites, run by `run.cjs`. Each prints `✓ name` / `✗ name  detail` per check and ends with `pass/total` | yes |
| `experiments/` | One-off measurement scripts behind the numbers in `AGENTS.md` and `docs/`, kept as they were run | yes |
| `baselines/` | Earlier `prompt.js` versions used for before/after comparisons | yes |
| `photos/` | Test photos (Wikimedia Commons, resized to 768 px), thumbnails and blur sets | **no** (`.gitignore`) |
| `results/` | Run transcripts (`*.log`) and API replies (`*-api.json`) | **no** (`.gitignore`) |

## Suites (`suites/`)

| Suite | Checks | Tests |
|---|---|---|
| `filter_prompt_test.cjs` | 45 | `filter.js` repeat and n/a rules, stair count and label, view change; `prompt.js` payloads and sensor paragraph |
| `app_test.cjs` | 115 | the real `app.js` in a fake browser: camera races, orientation and Android flip, blur gate, reasoning modes, Fast + Low, Ask, distance sensor, pause while speaking, History logging |
| `speech_queue_test.cjs` | 12 | `speech.js`: first-chunk start, in-order playback, odd byte splits, interrupt, retry, cancel |
| `speech_priority_test.cjs` | 8 | hazard clips cut non-hazard speech, never other hazards |
| `speech_stall_test.cjs` | 1 | a stalled speech download is given up |
| `beeper_test.cjs` | 27 | beep curve, scheduler, ducking, stale sensor, `Beeper.reading` |
| `recorder_test.cjs` | 11 | end-of-speech detection, silence trim |
| `ui_test.cjs` | 16 | settings sheet, segmented control, tap to repeat, hazard highlight |
| `history_ui_test.cjs` | 21 | History sheet |
| `log_test.cjs` | 16 | History storage |
| `distance_server_test.cjs` | 11 | real `server.js`: ESP `POST /distance` → SSE stream (`run.cjs` starts the server on ports 18080/15000) |

To add a suite: write `suites/<name>_test.cjs` that loads code from `../../public` via `__dirname`, prints one `✓`/`✗` line per check and `pass/total` last, then add it to `SUITES` in `run.cjs`.

## Experiments (`experiments/`)

Kept exactly as run, so the measurements in the docs can be traced and repeated. Most take paths as arguments (the old scratch-folder habit), e.g. from `narrator/`: `node eval/experiments/stairtest.cjs "$PWD/prompt.js" .env eval/photos/stairs 4` (module paths must be absolute, since `require` resolves them from the script's folder). Scripts that call `localhost:18080` need the server running on that port. Some rely on prompt or filter functions that have changed since; read a script before trusting its output today.

| Script | Measured | Result it produced |
|---|---|---|
| `eval.cjs` | first prompt eval: fresh / same view / changed view per photo | original repeat rules |
| `safety_eval.cjs` | old vs new prompt, hazard label per photo | labels 16/34 → 29/34 |
| `focus.cjs`, `variants.cjs` | two prompt versions side by side | focus-on-center rule; softer "Already said" wording |
| `doors.cjs` | door mentions on open-space photos | 0/36 false doors |
| `stairtest.cjs`, `stairs2.cjs`, `steps.cjs`, `stairs_rows_2026-10-17.json` | stair direction and count vs ground truth | direction 30/36; × 0.75 count factor |
| `ocr.cjs` | room sign at 512 vs 768 px | 768 px frames |
| `speed.cjs`, `lat.cjs` | latency by frame size and concurrency | 3 in flight, 768 px |
| `motion.cjs`, `feat.mjs`, `probe.mjs`, `ctx.mjs` | 2-frame clips, API features, context probes | single frames (`MOTION_FRAMES = false`) |
| `replay.cjs` | one photo with a given "Already said" list | repeat wording |
| `walk.cjs`, `walk2.cjs` | simulated walk: scene change → alert time | 0.7–1.5 s; view-change reset |
| `tune.cjs`, `tune_new.cjs` | view-change threshold on thumbnails | `VIEW_CHANGE = 0.5`; flat-image fix |
| `blur_calib.cjs`, `blur_api.cjs` | blur score calibration; blurred photos through the API | `BLUR_RATIO = 0.5` |
| `reason_bench.cjs`, `reason_fast.cjs` | reasoning Off / Low / High latency and tokens | "think briefly" for Low |
| `sensor_eval.cjs`, `sensor_conflict.cjs`, `sensor_ground.cjs`, `sensor_label.cjs` | distance reading in requests, incl. contradicting readings | sensor wording; `fixStairLabel` |
| `vad_e2e.cjs` | spoken questions end to end through `/api/ask` | 14/14 answers |
| `early_bench.cjs` | reply → first audio byte, with simulated network hop | early speech: 901 → 510 ms |
| `tts_speed.cjs`, `tts_silence.cjs`, `tag_bench.cjs`, `tts_tagcheck.cjs`, `fast_opts.cjs` | ElevenLabs latency, clip length, delivery tags | PCM streaming; `[rapidly]` tag |
| `queue_test.cjs` | old MP3 version of the speech queue test | superseded by `suites/speech_queue_test.cjs` |

## Photos (`photos/`)

Not in git. If you don't have them, ask a teammate for the folder or rebuild it from Wikimedia Commons (`sips -Z 768 <file>`). `api_eval.cjs` needs `photos/stairs/`, `photos/eval768/` and `photos/open2/`.

| Folder | Contents |
|---|---|
| `eval768/` | core set at 768 px: stairs, curb, crosswalk, pothole, building sign, room sign, corridor, cyclist (`eval/` holds the originals) |
| `stairs/` | 3 up, 3 down, incl. one side-on (`down2`, often misread as up) |
| `open/`, `open2/` | open spaces and doors, for the door rule |
| `walkimg/` | all scenes for the simulated walk |
| `thumbs/`, `sharp/`, `blurtest/` | BMP thumbnails for view-change and blur calibration; blurred copies |
| `misc/` | frame-size and OCR tests (`cw_*`, `room_*`), cyclist close-up, early probes |
