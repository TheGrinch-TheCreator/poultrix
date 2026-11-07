# Spec: always-live

Status: **APPROVED 2026-11-06** · 2026-11-06 · Module `always-live` (see `CAPABILITY_MAP.md`)

## Objective
Poultrix has one operating state: **automatic control (LIVE)**. Today there are SAFE/TEST modes and a LIVE/SAFE toggle. SAFE switches every output off, and once in SAFE the system often never returns (any serial hiccup, including during bypass, permanently blocks recovery). The owner wants:
- no SAFE mode and no way to switch to it;
- the Arduino keeps running climate control with its current stage settings even if the Pi or USB link is lost, and only shows "Pi offline";
- entering and using bypass never leaves the system stuck outside automatic control.

### User stories
- As the owner, after any reboot (Pi, Arduino or both), the house is under automatic temperature/lighting control without me pressing anything.
- As the owner, if the Pi crashes at night, the heater and fans keep responding to temperature for the current stage.
- As a maintainer, when I leave bypass (or the bypass link times out), the Arduino goes back to automatic control. It never goes to "everything off".
- As a viewer, the app header shows a status (Online / Arduino offline / Pi offline), not a mode switch.

## Behavior

### Arduino firmware
| Situation | New behavior | Old behavior |
|---|---|---|
| Boot | Relays preloaded off, then automatic control starts with the EEPROM stage as soon as the DHT22 gives a valid reading. Prints `BOOT:AUTO`. | `BOOT:SAFE`, all off until Pi handshake |
| No `SYS:PING` for 10 s | Keep automatic control. Set `piOnline=false`, print `PI:OFFLINE` once. LCD line shows `Pi: OFFLINE`, yellow LED on. Stop any feeding (close gates). | Switch to SAFE, all outputs off |
| Ping resumes | `piOnline=true`, print `PI:ONLINE` | (handshake needed) |
| DHT22 read fails | Heater and fans off **for that reading only** (fault response, as today). Resume on the next valid reading. | same |
| Maintenance (bypass) ping timeout 10 s | Leave maintenance, return to **automatic control** (re-evaluate heater/fans/LED immediately). Print `BYPASS_ACK:TIMEOUT`. | everything off |
| `BYPASS:OFF` | Return to automatic control immediately | everything off |
| `FEED:DISPENSE` | Allowed only when `piOnline` and not in maintenance | required LIVE |
| `MODE:SAFE`, `MODE:TEST`, `MODE:LIVE[:token]`, `TEMP:`, `LUX:`, `SERVO:ANGLE:` | Removed. Reply `ERROR:MODE_REMOVED` / `ERROR:UNKNOWN_COMMAND` | various |
| `SENSOR:CHECK` | Works at any time (read-only) | SAFE only |
| Status block | `MODE_STATUS:LIVE` always (kept so the Pi/UI/telemetry don't break), plus `PI_STATUS:ONLINE` or `OFFLINE` | `MODE_STATUS:<mode>` |

Delete: the `SystemMode` enum and its TEST/SAFE branches, `controlTestLighting`, `testLux`, the tokenized LIVE handler, and the legacy gate 3 path.

### Raspberry Pi (`app.py`)
- Remove the recovery system: `recovery_*` globals, `arduino_recovery_worker`, `recovery_block`, `save_live_preference` / `load_live_preference`, the LIVE ACK timeout in the heartbeat worker, and the `MODE_ACK` / `BOOT:SAFE` handling.
- Remove routes `/api/mode/live`, `/api/mode/safe`, `/api/mode/test` (return 410 with "Mode switching removed; Poultrix is always automatic"). `/api/recovery/status` is replaced by status fields in `/api/status` (`connected`, `arduinoOnline`, `piSeenByArduino`). It is kept as an alias for one release.
- Serial loss: just reconnect and send `SYS:INIT` and `STATUS`. No mode commands, nothing to "authorize".
- **Bypass session survives a serial hiccup.** On serial loss the token is kept, `manualControlsPaused=true` is set and the overrides are cleared. The Arduino has returned to automatic control by itself. After reconnect, the UI shows "Connection lost; manual control paused" with **Resume**, which re-sends `BYPASS:ON`.
- Feeding and AI stage-apply checks change from `mode == "live"` to `connected and arduinoOnline`.
- `/api/sensors/check` stops requiring SAFE.

### Root cause of the bypass hiccup (to confirm on the Pi)
The first implementation task is diagnostic. Capture `journalctl` output for `app.py` while using bypass and look for the first of:
1. `BOOT:SAFE` (or `BOOT:AUTO` later) → the **Arduino reset**, most likely a brownout from the servos/relays drawing power through the Mega, or a USB re-enumeration. Fix: hardware (separate servo PSU, common ground) plus this spec (a reset no longer leaves the system stuck).
2. `No serial RX for 15 seconds` → the Arduino loop stalled or the Pi reader blocked. Fix: reduce bypass serial bursts (`BYPASS:SIM:*` every 2 s), and log loop time on the Arduino.
3. `WATCHDOG:TIMEOUT` → pings lost. Fix: same as 2.

Whatever the cause, after this spec the outcome is "brief Pi offline, then automatic control continues". It is no longer "stuck in SAFE".

### Frontend
- `AppShell.tsx`: replace the LIVE/SAFE toggle button with a read-only status pill (Online · Arduino offline · Pi offline), using the same pill styles. Remove the confirm dialog and `toggleSystemMode`.
- `bypass.tsx`: the "return to live" copy becomes "Return to automatic control". Show "manual control paused" after a hiccup.
- Remove other "SAFE"/"TEST mode" wording in the UI.

### Docs
CLAUDE.md (modes, protocol list, Finisher-ack note), Obsidian `SERIAL_PROTOCOL`, `ARDUINO`, `BACKEND`, `BYPASS_MODE`, `TEMPERATURE_CONTROL`, `API_REFERENCE`, `ARCHITECTURE_DECISIONS` (supersede AD-02/03/04/07), `KNOWN_ISSUES`, `CURRENT_STATUS`, `TEST_RESULTS`.

## Tech Stack
Arduino Mega (Arduino IDE; DHT, LiquidCrystal_I2C, Adafruit PWM Servo Driver). Python 3 Flask on the Pi. TanStack Start / React 19 frontend. No new dependencies.

## Commands
```
# Frontend
npm run lint
npx tsc --noEmit        # no new errors beyond today's 13
npm run build

# Firmware: Arduino IDE → Mega 2560 → Verify, then Upload; Serial Monitor 9600, newline

# Pi
cd raspberry-pi && python3 app.py
journalctl -u <poultrix service> -f      # or the terminal running app.py
curl -s http://127.0.0.1:5000/api/status | python3 -m json.tool
curl -i -X POST http://127.0.0.1:5000/api/mode/safe        # expect 410
```

## Project Structure (files touched)
```
arduino/firmware/poultrix_arduino.ino
raspberry-pi/app.py
src/components/poultrix/AppShell.tsx
src/routes/bypass.tsx
src/lib/live-hardware.ts            (status fields/types)
CLAUDE.md
```

## Code Style
Firmware: keep the existing flat style. Example of the new watchdog branch:
```cpp
// Pi heartbeat lost: keep automatic climate control, stop feeding, report.
if (piOnline && millis() - lastHeartbeat >= WATCHDOG_TIMEOUT_MS) {
  piOnline = false;
  for (uint8_t i = 0; i < 2; i++) closeGate(i, "STOPPED");
  stopGroups();
  Serial.println(F("PI:OFFLINE"));
}
```
Python: same compact Flask style as `app.py`; no new modules.

## Testing Strategy
No automated tests exist. A Python test harness is decided in `remote-access`. For this module:
- **Static:** `npm run lint`, `npx tsc --noEmit`, `npm run build`, Arduino IDE Verify (compiles).
- **Bench (Arduino only, Serial Monitor, Pi unplugged):** boot shows `BOOT:AUTO`; with a warm/cool DHT22 the heater/fans react; after 10 s `PI:OFFLINE` and control continues; `MODE:SAFE` returns an error; `BYPASS:ON` then silence for 10 s returns to automatic control (not all-off).
- **Integrated (Pi + Arduino):** stop `app.py` → relays keep following temperature; restart → `PI:ONLINE`, no button needed; unplug and replug USB during bypass → UI shows paused, Resume works; header shows a status, with no toggle.
- Record results in Obsidian `TEST_RESULTS`.

## Boundaries
- **Always:** relays preloaded OFF before `pinMode`; heater/fans off on an invalid DHT reading; gates close when the Pi goes offline; keep `MODE_STATUS:LIVE` in the protocol for compatibility.
- **Ask first:** changing temperature bands, hysteresis or adding an over-temperature cutoff (separate safety work); changing the feeding safety caps; hardware/wiring changes.
- **Never:** add any mode that switches all outputs off because the Pi is offline; let the Arduino dispense feed without a Pi heartbeat; leave dead SAFE/TEST code paths reachable.

## Success Criteria
1. No firmware, Pi or UI path can put the controller in SAFE or TEST. `grep -n "SAFE_MODE\|TEST_MODE" poultrix_arduino.ino` returns nothing.
2. With the Pi stopped for ≥ 60 s, the Arduino keeps switching heater/fans according to the stage band (observed on the bench), and the LCD shows Pi offline.
3. After a cold boot of both devices, automatic control is active without any user action.
4. Ending bypass (exit, return, or 10 s ping timeout) returns to automatic control, never all-off.
5. A USB unplug/replug during bypass leads to "manual control paused", then Resume works. No stuck state.
6. Header shows status only; `POST /api/mode/*` returns 410.
7. Feeding is refused while the Arduino reports the Pi offline and while maintenance is active.
8. Static checks show no new errors; the firmware compiles.

## Resolved decisions (owner, 2026-11-06)
1. Pi/serial offline → the Arduino **keeps running automatic control** with the current stage's targets (heater, fans **and LED** keep reacting). Relays are not frozen.
2. Feeding stops while the Pi is offline (gates close).
3. The heater and fans turn off on an invalid DHT22 reading (fault response, resumes on the next valid reading).
4. LCD: while the Pi is offline, the title line "POULTRIX MONITOR" is replaced by `Pi: OFFLINE`.
5. A physical thermal cutoff on the heat lamps is recommended; out of scope.
