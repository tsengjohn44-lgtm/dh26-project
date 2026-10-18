# Proximity sensor (ESP8266 + ultrasonic)

Code: `esp8266_main.ino` (board), the distance section of `narrator/server.js`, `narrator/public/beeper.js` (phone).

## The board (`esp8266_main.ino`)

- **Hardware:**
  - ESP8266 (NodeMCU 1.0 in the Arduino IDE; this is not an ESP32 sketch)
  - HC-SR04-style ultrasonic sensor: trigger on GPIO 12 (D6), echo on GPIO 14 (D5)
  - buzzer on GPIO 16 (D0)
- **Loop, about every 200 ms plus the POST:**
  1. Trigger the sensor and time the echo (30 ms timeout, ~4 m range).
  2. Below 5 cm, sound the board's own quiet buzzer, independent of the app.
  3. POST to `serverUrl`, form-encoded:
     `distance=<metres, 3 decimals>|Out_of_Range&uptime=<ms>&rssi=<dBm>&drops=<n>&reset=<reason>`
- **Health fields** (for debugging dropouts):
  - `uptime`: time since boot
  - `rssi`: Wi-Fi signal strength
  - `drops`: Wi-Fi disconnects since boot
  - `reset`: why it last booted
- **Built-in LED:** solid = on Wi-Fi, blinking = not connected, off = not running (no power, or rebooting).
- **Wi-Fi:** auto-reconnect on, modem sleep off (sleep can cause dropouts with some routers).
- **`serverUrl`:** use the address the server prints at startup (`ESP8266: set serverUrl to …`). The board must be on the **same Wi-Fi as the laptop**. It can't use `.local` names, so it needs the laptop's IP.

### Port
The server listens for the board on port 5000 (`DISTANCE_PORT`). **On macOS, the AirPlay Receiver usually holds port 5000**: turn it off under System Settings → General → AirDrop & Handoff, or point the sketch at port **8080**, which also accepts `/distance`. The server prints a warning if 5000 is busy.

### Power: the usual cause of "works on USB, drops on battery"
- **Supply spikes:** Wi-Fi transmit pulls short spikes of 300–400 mA. Weak supplies sag and the ESP resets.
- **Pins:**
  - External 5 V goes to **VIN** (never 3V3); its ground to the board's GND.
  - On many NodeMCU boards the **VU** pin is powered **only from USB**. A sensor wired there dies when USB is unplugged.
- **Batteries and modules:**
  - **9 V batteries** are a poor fit: they read fine on a meter but sag under the spikes.
  - Breadboard power modules need ~6.5–7 V in, to keep a steady 5 V.
  - Better: a USB power bank into the micro-USB port, 3–4 AA cells into VIN, or a lithium cell with a 5 V booster.
- **Capacitor:** add **470–1000 µF** across 5 V and GND near the board.
- **Checking:** measure 3V3 and VIN to GND *while the board is running* (about 3.3 V and 5 V).
- **Battery voltage from the board itself** (not implemented): a 680 kΩ resistor from battery + to A0 gives a ~0–10 V range (`analogRead(A0) / 1023.0 * 10.0`). Alternatively, `ADC_MODE(ADC_VCC)` + `ESP.getVcc()` reads the 3.3 V rail with no wiring.

## Server side (`server.js`)

- **`POST /distance`:**
  - parses the form body, stores `{ metres | null, at }`, pushes it to every open phone, and replies 204
  - bad values → 400
  - older sketches that send only `distance=` still work
- **`GET /api/distance/stream`:** Server-Sent Events.
  - Each reading is pushed as `data: {"metres":0.42,"at":…}`. A new connection first gets the latest reading with `ageMs`, so the phone never treats an old reading as live, even if clocks differ.
  - Keep-alive every 15 s.
- **Health log** in the server terminal. It explains what kind of failure each dropout was:
  - `ESP8266 connected (running 10 s, last reset: Power On), signal -58 dBm`
  - `ESP8266 silent: no reading for 3 s`
  - `back after ~4.7 s: no reboot … Wi-Fi/network dropped` → a network problem
  - `back after ~4.5 s: it REBOOTED (reset reason: …). Likely a power problem` → a power problem
  - every 30 s: readings count, signal, uptime, Wi-Fi drops

## Phone side: beeps (`beeper.js`)

- **Stream:** opened on Start and closed on Stop. No reading for 1.5 s → silent, and the status shows "sensor offline".
- **Curve** `beepParams(metres, intensity)`:
  - silent beyond 2 m and when out of range
  - closer → faster, louder and higher-pitched
  - ≤10 cm → fast, full volume, "urgent"

  | Distance | Every | Loudness | Pitch |
  |---|---|---|---|
  | 2 m | 1.20 s | 3% | 650 Hz |
  | 1.5 m | 0.99 s | 5% | 688 Hz |
  | 1 m | 0.57 s | 17% | 802 Hz |
  | 0.5 m | 0.22 s | 51% | 993 Hz |
  | 0.25 m | 0.12 s | 79% | 1117 Hz |
  | ≤ 0.1 m | 0.08 s | 100% | 1200 Hz |

  Formula: closeness `c = (2 − d) / 1.9`, shaped `p = (c^(1/intensity))²`; interval `1.2 × (0.08/1.2)^p` s, gain `0.03 + 0.97·p^1.5`.
- **Scheduler:** beeps are scheduled 150 ms ahead on the audio clock, checked every 50 ms, for steady timing. Getting closer speeds up immediately.
- **Sound:** sine tone, 5 ms attack and 60 ms decay (no clicks).
- **Ducking:** 30% volume while the voice speaks, except at ≤10 cm. Shares the voice's `AudioContext`, so the Start tap unlocks both on iPhone.
- **Settings:**
  - Beeps on/off in the bottom bar
  - Beep volume (default 60%) and Intensity (0.5–2×; higher ramps up sooner) under Settings → Proximity sensor
  - the status pill shows the distance when an obstacle is within range

## Accuracy notes

- **Doppler** doesn't matter: the sensor measures echo *time*, and at walking speed the 40 kHz echo shifts only ~0.9%, well inside the receiver's band.
- **Update rate matters more:** readings arrive every 0.2–0.45 s (`delay(200)` plus up to 250 ms per HTTP POST), so you move 30–70 cm between readings at walking pace. Shortening both is the next easy win.
- **Narrow beam** (~15°): it only sees what's straight ahead. Soft or angled surfaces can deflect the echo and read as "out of range". It can't detect drops such as stairs going down or curbs; the camera covers those.
- **Temperature:** the code assumes ~20 °C; about 3% error at 0 °C.

## Not yet confirmed on a device
The beeps and SSE feed were tested with simulated readings and a fake audio clock (20 + 11 checks). The health logging was tested with simulated dropout scenarios. Real-board power behaviour is still being debugged.

## Idea, not built: feeding distance into Perceptron
The reading could tell the model "something solid is straight ahead at <1.5 m: name it, don't say the number". That would help with glass doors and poles, and make "close" accurate. See the discussion in the session notes before building it.
