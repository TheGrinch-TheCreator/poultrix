# Bench Test Procedure: always-live firmware (Arduino Mega 2560)

Spec: `SPEC-always-live.md` · Tasks: T2–T4 in `tasks/todo.md` · Gate: **Checkpoint A**

> Written **before** the firmware change. The expected results describe the approved spec. If the implementation changes a message string, this document is updated before testing.
> **Nothing passes until it is observed.** Fill in the *Actual* and *Result* columns during the test. Leave "—" for untested steps. A step without a result is not a pass.

---

## 0. Safety rules (read first)

1. **No mains (220 V) loads connected.** Disconnect the heat lamps, the AC fans and the 220 V LED bulbs from the relay *output* terminals (COM/NO/NC). Relays are judged only by:
   - the relay-module indicator LED (on = energized; modules are active LOW);
   - the click;
   - optionally, a multimeter on **continuity** between COM and NO, with no mains present.
2. **Bench, not the poultry house.** No birds near the setup. Do it on a non-flammable surface.
3. **Servo power from a separate 5–6 V supply** with a **common ground** to the Mega. Don't power 10 servos from the Mega's 5 V pin.
4. **Empty feed compartments.** No feed in the hopper. Keep fingers and tools clear of the gates while they move.
5. **Pi disconnected.** Only the PC (Arduino IDE) is on the Mega's USB port.
6. **Abort immediately** (unplug USB and the servo supply) if any of these happen:
   - any relay energizes at power-up before the first status block;
   - a burning smell, or a hot servo or regulator;
   - a servo buzzes or stalls against an end stop for more than 2 s;
   - the Mega resets repeatedly (`BOOT:AUTO` appears without you causing it).

   Record what happened.
7. **Restore the house stage at the end.** `STAGE:` writes to EEPROM. Record the starting stage (section 2) and set it back (section 12).

## 1. Equipment
- Arduino Mega 2560 with the always-live firmware (record the git commit) and the existing shield/wiring: DHT22 (D30), LDR (A0), 6-channel relay module (fans D22/D23/D31/D25, LED D32, heater D28), PCA9685 (0x40) with 10 servos (ch 0–4, 11–15), 2× HX711 (hopper D3/D2, trough D5/D4), 20×4 I²C LCD (0x27), status LEDs (green D35, yellow D36)
- PC with the Arduino IDE. Serial Monitor at **9600 baud**, line ending **"Newline"**
- Separate 5–6 V servo supply (≥ 3 A recommended)
- Phone torch, an opaque cup (to cover the LDR), a known mass (e.g. 500 g), a stopwatch
- Optional: multimeter, room thermometer

## 2. Setup and baseline
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| S1 | Record the room temperature from the thermometer | 29.2 | °C | 29.2 |
| S2 | Flash the firmware (IDE **Verify** first; record flash % and RAM %) | Compiles, no errors | flash 10% RAM 17% |✅|
| S3 | Open the Serial Monitor (this resets the Mega) | `BOOT:AUTO`, then status blocks every ~2 s | |✅|
| S4 | Send `STATUS`; write down `STAGE_OK:` | One status block with `MODE_STATUS:LIVE` and `PI_STATUS:OFFLINE` | stage = STARTER |✅|
| S5 | Watch the relay LEDs during S3 | **No relay on before the first status block**; afterwards only what the control logic asks for | |✅|

## 3. Boot behavior and removed modes
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| B1 | Unplug USB, wait 5 s, plug in, reopen the monitor | `BOOT:AUTO`; stage = S4 value (EEPROM kept); control starts with no command sent | |✅|
| B2 | Send `MODE:SAFE` | `ERROR:MODE_REMOVED`; relay states unchanged | |✅|
| B3 | Send `MODE:TEST` | `ERROR:MODE_REMOVED`; unchanged | |✅|
| B4 | Send `MODE:LIVE` and `MODE:LIVE:0123456789abcdef0123456789abcdef` | `ERROR:MODE_REMOVED` (both) | |✅|
| B5 | Send `TEMP:40`, `LUX:5`, `SERVO:ANGLE:5,90` | Errors (`ERROR:MODE_REMOVED` or `ERROR:UNKNOWN_COMMAND`); no relay or servo moves | |✅|
| B6 | Send `HELLO` | `ERROR:UNKNOWN_COMMAND` | |✅|

## 4. Sensors
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| N1 | Read `TEMPERATURE:` / `HUMIDITY:` from 3 status blocks | Within ±2 °C of the room thermometer; humidity plausible (30–95%) | n1 29.2  thermometer is 29.2|✅|
| N2 | Send `SENSOR:CHECK` | `SENSOR_CHECK:OK` plus four `SENSOR_*` lines (works without any mode) | |✅|
| N3 | Cover the LDR with the cup for 6 s, read `LIGHT_RAW:` / `LUX:` | Lux drops (expect < 50) | raw 12 lux 21.3 |✅|
| N4 | Shine the torch on the LDR | Lux rises (expect > 50) | raw 178 lux 1002 |✅ |
| N5 | Empty trough: read `TROUGH_WEIGHT:` 3× | `RAW,<n>,ESTIMATED,<g>`, stable within ±20 g | |✅|
| N6 | Put the known mass on the trough | Estimate ≈ the mass (record the error; calibration is provisional, so this is not pass/fail on accuracy) | mass __ g, read __ g |just use the calibration for this|
| N7 | Same for the hopper (`HOPPER_WEIGHT:`) | Readings present; record drift over 1 min | |✅|
| N8 | LCD | Line 0 `Pi: OFFLINE` (Pi not pinging), line 1 stage, line 2 hopper kg, line 3 temperature | |✅|

## 5. Temperature control (relays, no mains)
Uses stage changes so room temperature lands in different bands. Bands: STARTER 32.2–35.0, GROWER 26.7–29.4, FINISHER 24.0–26.0 °C. Fans: +1 per °C above max, up to 4. Heater on below min.
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| T1 | `STAGE:STARTER` (room < 32.2 °C expected) | `STAGE_OK:STARTER`; **heater relay (D28) ON**, fans off, LED relay off (heater forces LED off) | |✅|
| T2 | `STAGE:FINISHER` | `STAGE_OK:FINISHER`; heater off; fan count matches (room − 26): ≤1 → 1, ≤2 → 2, ≤3 → 3, >3 → 4 | room 29.2 °C, fans 4 |✅|
| T3 | `STAGE:GROWER` | Heater on if room < 26.7; off with 0 fans if 26.7–29.4; fans if > 29.4 | |✅|
| T4 | In FINISHER, warm the DHT22 gently with your hand (no heat gun) | Fan count increases as `TEMPERATURE:` rises | |✅|
| T5 | Watch for 2 min near a band edge | Note any relay chattering (toggle each 2 s). Expected with no hysteresis; **record it, don't fail it** | |✅|

## 6. DHT22 fault response
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| D1 | In STARTER (heater on), unplug the DHT22 data wire | Within ~4 s: `DHT22_STATUS:ERROR`; **heater and fans off** | |✅|
| D2 | Wait 10 s | Stays off; no reset | |✅|
| D3 | Reconnect the DHT22 | `DHT22_STATUS:OK`; heater resumes per the band | |✅|

## 7. Lighting control
Use GROWER or FINISHER so the heater is off.
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| L1 | Cover the LDR | `AUTO_LED:ON_DARK`; LED relay (D32) ON | |✅|
| L2 | Torch on the LDR | `AUTO_LED:OFF_BRIGHT`; LED off | |✅|
| L3 | `STAGE:STARTER` (heater on) and cover the LDR | LED stays **off** while the heater is on (current design; see the `LIGHTING_CONTROL` note) | |✅|

## 8. Pi heartbeat (simulated by hand)
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| P1 | Send `SYS:PING` | `PI:ONLINE`; LCD line 0 back to `POULTRIX MONITOR` | |✅|
| P2 | Send nothing for 12 s (stopwatch) | After ~10 s: `PI:OFFLINE` **once**; LCD `Pi: OFFLINE`; yellow LED on; **heater/fans/LED unchanged and still controlled** | t = 10 s |✅|
| P3 | While offline, cover the LDR (GROWER) / warm the DHT (FINISHER) | LED and fans still react → control continues without the Pi | |✅|
| P4 | `SYS:READY` then `SYS:PING` | `SYSTEM_HEALTH:READY`; `PI:ONLINE`; green LED on | |✅|

## 9. Servo gates and feeding (empty compartments, servo PSU on)
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| G1 | Power on the servo supply; send `SERVO:STATUS` | 10 `SERVO_CHANNEL:` lines at 0°; gates physically closed | |✅|
| G2 | Without a recent ping, send `FEED:DISPENSE:1,2000` | `FEED_ERROR:PI_OFFLINE`; no movement | |✅|
| G3 | `SYS:PING`, then within 5 s `FEED:DISPENSE:1,2000` | `FEED_GATE:1,STARTED,2000`; ch 0–4 open to 90° together; close after ~2 s with `FEED_GATE:1,COMPLETED,2000` | |✅|
| G4 | Same for compartment 2 | ch 11–15 open/close; `FEED_GATE:2,…` | |✅|
| G5 | `SYS:PING`, `FEED:DISPENSE:1,10000`, then `FEED:STOP` after ~2 s | Gates close at once; `FEED_GATE:…,STOPPED` | |✅|
| G6 | **Pi-drop closure:** `SYS:PING`, wait 8 s, then `FEED:DISPENSE:1,10000`, then send nothing | About 2 s later: `PI:OFFLINE` and gate 1 `STOPPED` (closed before its 10 s timer) | closed after 2 s just after the pi goes offline |✅|
| G7 | Bad input: `FEED:DISPENSE:1,0`, `FEED:DISPENSE:1,10001`, `FEED:DISPENSE:3,1000`, `FEED:DISPENSE:1,abc` (each after a `SYS:PING`) | Each gives a `FEED_ERROR:` and no movement | |✅|
| G8 | **Brownout check:** during G3/G4 watch the monitor and the LCD | **No** `BOOT:AUTO` during servo movement. If it appears, the servo supply or ground is inadequate: record it (likely cause of the original bypass problem) | |✅|

## 10. Bypass (maintenance) behavior
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| M1 | In STARTER (heater on), send `BYPASS:ON` | `BYPASS_ACK:ON`; **heater off**; gates closed | |✅|
| M2 | `BYPASS:PING` every ≤ 8 s from here until M6 | — | |✅|
| M3 | `BYPASS:RELAY:1,1` … `BYPASS:RELAY:5,1`, then each `,0` | `BYPASS_ACK:RELAY:n,v` and the matching relay LED for fans 1–4 and LED (5) | |✅|
| M4 | `BYPASS:RELAY:6,1` then `BYPASS:RELAY:6,0` (**mains disconnected**) | Heater relay on, then off, each ACKed | |✅|
| M5 | `BYPASS:GROUP:1,2000` | `BYPASS_ACK:GROUP:1,2000`; ch 0–4 open; `BYPASS_GROUP_DONE:1` after ~2 s | |✅|
| M6 | `BYPASS:RELAY:1,1`, then **stop pinging** for 12 s | After ~10 s: `BYPASS_ACK:TIMEOUT`; outputs return to **automatic control** (heater back on in STARTER), **not all-off** | |✅|
| M7 | `BYPASS:ON`, `BYPASS:RELAY:2,1`, `BYPASS:OFF` | `BYPASS_ACK:OFF`; outputs immediately match automatic control | |✅|
| M8 | Outside bypass: `BYPASS:RELAY:1,1` and `BYPASS:GROUP:1,1000` | `BYPASS_ERROR:NOT_ACTIVE`; nothing moves | |✅|
| M9 | In bypass, after a `SYS:PING`: `FEED:DISPENSE:1,1000` | `FEED_ERROR:DISABLED` (no normal feeding during maintenance) | |✅|

## 11. Soak test
| ID | Step | Expected | Actual | Result |
|---|---|---|---|---|
| K1 | Leave it running 30 min (no pings), stage GROWER | No `BOOT:AUTO` (no resets); status blocks keep arriving; LCD updates | |✅|
| K2 | During K1, send `SYS:PING` every ~5 s for 2 min, then stop | `PI:ONLINE` once, then `PI:OFFLINE` once after the pings stop | |✅|

   ## 12. Wrap-up
   | ID | Step | Expected | Actual | Result |
   |---|---|---|---|---|
   | W1 | `STAGE:<value from S4>` | `STAGE_OK:<S4 value>` | |✅|
   | W2 | Power cycle, `STATUS` | Stage = S4 value | |✅|
   | W3 | Disconnect the servo supply, then USB | — | |✅|

## Pass criteria for Checkpoint A
All of S2–S5, B1–B6, D1–D3, P1–P4, G2–G7, M1–M9 and K1 pass, and G8 shows no reset. N- and T-rows must behave as described. Calibration accuracy (N6/N7) and chattering (T5) are *recorded*, not gating. Any failure → fix the firmware (or the wiring/power for G8) and re-run the affected section.

## Recording
Copy the completed tables, the firmware commit, the date and the tester into Obsidian `07-Development/TEST_RESULTS.md`, under "YYYY-MM-DD: always-live bench test". Only then mark Checkpoint A's first box in `tasks/todo.md`.
