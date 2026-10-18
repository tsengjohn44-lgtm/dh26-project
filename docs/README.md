# Scene Narrator documentation

Scene Narrator is a phone web app for blind and low-vision pedestrians. The phone's camera is sent to the Perceptron vision model. Short, navigation-focused alerts are shown on screen and spoken with ElevenLabs. An optional ESP8266 ultrasonic sensor adds proximity beeps.

Start with **[architecture.md](architecture.md)**, then read the system you're working on. Each system doc ends with a **Design decisions** table: what was chosen, why (with measurements where there are any), and what was rejected. Architecture also covers why the project doesn't use a bigger web stack.

| Document | Covers |
|---|---|
| [architecture.md](architecture.md) | Components, data flow, request lifecycle, where each piece runs |
| [optimization.md](optimization.md) | Every speed and efficiency change since the first build, with measurements, plus what was tried and rejected |
| [vision.md](vision.md) | Camera capture, blur gate, view-change detection, request scheduling, the prompt, reasoning modes, the reply filter |
| [questions.md](questions.md) | Asking questions by voice: microphone → WAV → Perceptron with the camera frame, answers spoken first |
| [speech.md](speech.md) | ElevenLabs text-to-speech: streaming, the queue, early start, pausing, iOS audio unlock |
| [proximity-sensor.md](proximity-sensor.md) | ESP8266 sketch, wiring and power, the `/distance` feed, beep curve, health logging |
| [ui.md](ui.md) | Screen layout, settings, accessibility, diagnostics overlay |
| [server-api.md](server-api.md) | HTTP endpoints, headers, environment variables, HTTPS and `.local` access |
| [testing.md](testing.md) | How each part was tested, measurement method, test photos, what still needs a real device |

`AGENTS.md` at the repo root is the working guide for AI coding agents: conventions, decisions, and open questions. These docs explain how the systems work. Where they overlap, the code is the source of truth.

**Status (2026-10-18):** most measurements come from the real Perceptron and ElevenLabs APIs, or from simulated browsers in Node. Several features have **not yet been confirmed on a phone**; each document says which.
