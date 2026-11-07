# Tasks: always-live

Spec: `SPEC-always-live.md` · Plan: `tasks/plan.md`
Deploy order: **firmware (Phase 1) must be flashed before the Pi change (Phase 2).**

---

## Task 1: Diagnose the bypass hiccup
**Description:** Reproduce "bypass → system goes to SAFE and doesn't return" on the current code and capture Pi logs, so the root cause (Arduino reset/brownout, RX timeout, or ping loss) is known. No code change.

**Acceptance criteria:**
- [ ] Logs captured from entering bypass until the failure (or 15 min with no failure)
- [ ] First failure marker identified: `BOOT:SAFE` / `Arduino boot detected`, `No serial RX for 15 seconds`, `WATCHDOG:TIMEOUT`, or `Serial error`
- [ ] Result and the bypass actions in use (relay, dispense, overrides) recorded in Obsidian `TEST_RESULTS`

**Verification:**
- [ ] Manual: `journalctl -u poultrix --since "10 min ago" --no-pager | grep -E "RECOVERY|ARDUINO|WATCHDOG|BOOT|HEALTH"`
- [ ] Live view while reproducing: `journalctl -u poultrix -f`

**Dependencies:** None · **Files:** none (Obsidian `TEST_RESULTS.md`) · **Scope:** XS

---

## Task 2: Firmware has a single automatic mode

**Status (2026-11-06):** implemented in `poultrix_arduino.ino`; compiles for Mega 2560 (arduino-cli, no sketch warnings; flash 26,040 B / RAM 1,465 B). **Not bench-tested yet.**
**Description:** Remove the `SystemMode` enum and the SAFE/TEST paths. On boot: relays preloaded off, EEPROM stage loaded, `BOOT:AUTO` printed, and automatic temperature + lighting control runs from the first valid DHT reading. `MODE:*`, `TEMP:`, `LUX:` and `SERVO:ANGLE:` reply `ERROR:MODE_REMOVED`. `SENSOR:CHECK` works at any time. The status block always sends `MODE_STATUS:LIVE`. Delete `controlTestLighting`, `testLux` and the legacy gate 3 code.

**Acceptance criteria:**
- [ ] `grep -nE "SAFE_MODE|TEST_MODE|currentMode" poultrix_arduino.ino` returns nothing
- [ ] After power-on, the heater/fans follow the stage band without any serial command
- [ ] `MODE:SAFE` → `ERROR:MODE_REMOVED`, and outputs unchanged

**Verification:**
- [ ] Arduino IDE Verify compiles (note flash/RAM %)
- [ ] Bench (Serial Monitor 9600, Pi unplugged): see `BOOT:AUTO`; warm the DHT22 by hand above the stage max → fan 1 on; send `STATUS` → `MODE_STATUS:LIVE`

**Dependencies:** None · **Files:** `arduino/firmware/poultrix_arduino.ino` · **Scope:** M (one large file)

---

## Task 3: Firmware keeps control when the Pi is offline

**Status (2026-11-06):** implemented in `poultrix_arduino.ino`; compiles for Mega 2560 (arduino-cli, no sketch warnings; flash 26,040 B / RAM 1,465 B). **Not bench-tested yet.**
**Description:** Replace the watchdog's "go to SAFE" with: `piOnline=false`, close both gates and stop groups, print `PI:OFFLINE` once, show `Pi: OFFLINE` on LCD line 0, yellow LED on. Climate control continues. On the next `SYS:PING`: `piOnline=true`, `PI:ONLINE`. Add `PI_STATUS:ONLINE|OFFLINE` to the status block. `FEED:DISPENSE` is refused (`FEED_ERROR:PI_OFFLINE`) when `!piOnline`. `piOnline` starts false at boot.

**Acceptance criteria:**
- [ ] With no pings for 10 s: `PI:OFFLINE` printed once; heater/fans/LED keep reacting to temperature/light
- [ ] A gate dispensing when the Pi drops is closed (`FEED_GATE:<n>,STOPPED`)
- [ ] `SYS:PING` → `PI:ONLINE`, LCD title restored

**Verification:**
- [ ] IDE Verify compiles
- [ ] Bench: send `SYS:PING`, then `FEED:DISPENSE:1,5000`, then stop sending → within ~10 s `PI:OFFLINE` + gate STOPPED; warm the DHT → fan still turns on

**Dependencies:** T2 · **Files:** `arduino/firmware/poultrix_arduino.ino` · **Scope:** S

---

## Task 4: Leaving bypass returns to automatic control

**Status (2026-11-06):** implemented in `poultrix_arduino.ino`; compiles for Mega 2560 (arduino-cli, no sketch warnings; flash 26,040 B / RAM 1,465 B). **Not bench-tested yet.**
**Description:** `maintenanceOff()` stops groups, closes gates and clears the LCD sim, then immediately re-runs `readLiveSensors()`, `controlTemperature()` and `controlLiveLighting()` instead of switching everything off. Used by `BYPASS:OFF` and the 10 s maintenance ping timeout. `BYPASS:ON` still forces the heater off on entry (unchanged).

**Acceptance criteria:**
- [ ] `BYPASS:ON`, `BYPASS:RELAY:1,1`, then no `BYPASS:PING` for 10 s → `BYPASS_ACK:TIMEOUT` and the outputs match automatic control (not all-off)
- [ ] `BYPASS:OFF` gives the same result immediately

**Verification:**
- [ ] IDE Verify compiles
- [ ] Bench: the steps above, comparing `FAN_STATUS`/`HEATER_STATUS` with the temperature band

**Dependencies:** T2 · **Files:** `arduino/firmware/poultrix_arduino.ino` · **Scope:** S

---

## Checkpoint A: Firmware done
- [x] Bench procedure `tasks/bench-test-always-live.md` completed by the owner, results recorded (Pi and mains disconnected). 2026-11-07, commit `ed46ebb4`
- [x] T2–T4 bench tests pass; IDE Verify clean (all gating rows ✅; G8 no reset)
- [ ] Flashed to the house Arduino **with the current, unchanged Pi code running**: dashboard shows LIVE; feeding/AI still work; no stuck state after unplugging/replugging USB
- [ ] Results in `TEST_RESULTS` (bench results recorded 2026-11-07; house-flash results pending); owner reviews before Phase 2

---

## Task 5: Pi drops the recovery system and mode routes
**Status (2026-11-07):** implemented, not committed. AST ✅, pyflakes no new warnings, off-Pi smoke test ✅ (mode routes 410, alias fields, LIVE after reconnect with no user action, sensor check while LIVE). **Not run on the Pi yet.**

**Description:** In `app.py`:
- Delete the `recovery_*` globals, `recovery_block`, `arduino_recovery_worker` (and its thread start), `save_live_preference` / `load_live_preference`, the LIVE ACK timeout in `arduino_heartbeat_worker`, and the `BOOT:SAFE` / `MODE_ACK:` / `ERROR:DHT22_NOT_READY` / `WATCHDOG:TIMEOUT` recovery branches. Also remove the recovery calls in `serial_worker` and `disconnect_arduino`.
- `/api/mode/live|safe|test` → 410 `"Mode switching removed; Poultrix is always automatic"`.
- `/api/recovery/status` becomes an alias returning `{connected, mode, arduinoOnline, piSeenByArduino}`.
- Parse `PI_STATUS:`, `PI:ONLINE/OFFLINE` and `BOOT:AUTO` (log a system event).
- `/api/sensors/check` stops requiring SAFE.
- Startup log: remove the recovery lines.

**Acceptance criteria:**
- [x] `grep -n "recovery_" raspberry-pi/app.py` returns only the alias route
- [ ] `POST /api/mode/safe` and `/api/mode/live` → 410
- [ ] After USB unplug/replug, `/api/status` shows `connected:true` and `operatingStatus:"LIVE"` with no user action

**Verification:**
- [x] `python -c "import ast;ast.parse(open('raspberry-pi/app.py',encoding='utf-8').read())"`
- [ ] On the Pi: curl `/api/status`, `/api/recovery/status`, `POST /api/mode/safe`

**Dependencies:** Checkpoint A · **Files:** `raspberry-pi/app.py` · **Scope:** M

---

## Task 6: Bypass session survives a serial hiccup
**Status (2026-11-07):** implemented, not committed. Off-Pi smoke test ✅ (same token returns 200 + `manualControlsPaused:true` + `connectionLostAt` after serial loss; Resume works; feeding refused while `PI_STATUS:OFFLINE` or disconnected). **Not run on the Pi yet.**

**Description:**
- Replace `invalidate_bypass_on_serial_loss()` with `pause_bypass_on_serial_loss()`: keep the token and expiry, set `bypass_paused=True`, clear overrides/sim readings, cancel the schedule test and simulation, and unblock pending ACK waits.
- Add `connectionLostAt` to `/api/bypass/status`. `/api/bypass/resume` (re-sends `BYPASS:ON`) is the way back.
- Readiness checks in `feeding_dispense`, `_feed_inputs`, `_feed_job_run`, `simulation_start_analysis` and `apply_confirmed_stage_to_arduino` use `connected and arduinoOnline` instead of `mode == "live"`. Feeding is refused while the Arduino reports `PI_STATUS:OFFLINE`.

**Acceptance criteria:**
- [ ] Unplug/replug USB during bypass → `/api/bypass/status` (same token) returns 200 with `manualControlsPaused:true`; Resume returns 200 and manual relays work again
- [ ] The Arduino is in automatic control during the gap (from T4 timeout)
- [ ] Manual feeding works when connected; refused when disconnected

**Verification:**
- [x] AST parse check
- [ ] On the Pi: log in to bypass, unplug USB 20 s, replug, call status/resume with the same token

**Dependencies:** T5 · **Files:** `raspberry-pi/app.py` · **Scope:** S

---

## Checkpoint B: Pi + Arduino integrated
- [ ] Stop `app.py` 60 s → the Arduino keeps controlling (heater/fan react), LCD `Pi: OFFLINE`; restart → online with no user action
- [ ] Cold boot of both devices → automatic control, dashboard Online
- [ ] Repeat T1's bypass routine → no stuck state
- [ ] Results in `TEST_RESULTS`; owner reviews

---

## Task 7: Header shows status, not a mode toggle
**Description:** In `AppShell.tsx`:
- Remove `toggleSystemMode`, the LIVE confirm dialog and the button.
- Show a read-only pill using the existing pill/dot styles: **Online** (Pi reachable, Arduino connected, Arduino sees Pi), **Arduino offline** (Pi reachable, `connected:false`), **Pi offline** (Pi unreachable).
- Read from `/api/status`. Add `arduinoOnline` / `piSeenByArduino` to the `Hardware` type in `live-hardware.ts`.

**Acceptance criteria:**
- [ ] No element in the header sends a POST
- [ ] The pill shows each of the three states correctly
- [ ] Layout and spacing unchanged on desktop and mobile

**Verification:**
- [ ] `npm run lint` (no new non-formatting errors), `npx tsc --noEmit` (≤ 13 errors), `npm run build`
- [ ] Manual on the LAN: stop the Pi API → "Pi offline"; unplug USB → "Arduino offline"

**Dependencies:** T5 · **Files:** `src/components/poultrix/AppShell.tsx`, `src/lib/live-hardware.ts` · **Scope:** S

---

## Task 8: Bypass page handles pause and Resume
**Description:** In `bypass.tsx`:
- "Return to live" copy becomes "Return to automatic control"; remove "not confirmed LIVE" messages.
- When status shows `manualControlsPaused` with `connectionLostAt`, show "Connection lost — manual control paused" and the existing Resume button.
- Use `API_URL` from `live-hardware.ts` instead of its own copy.

**Acceptance criteria:**
- [ ] After a USB hiccup the page shows the paused message, and Resume restores manual controls without logging in again
- [ ] No "SAFE"/"LIVE mode" wording left on the page

**Verification:**
- [ ] lint / tsc / build as in T7
- [ ] Manual on the LAN with T6's hiccup routine

**Dependencies:** T6 · **Files:** `src/routes/bypass.tsx` · **Scope:** S

---

## Checkpoint C: Frontend
- [ ] Static checks pass with no new errors
- [ ] Spec success criteria 1–8 all verified (`SPEC-always-live.md`)

---

## Task 9: Docs and graph
**Description:** Update CLAUDE.md (modes, protocol list, recovery, Finisher-ack text). Update the Obsidian notes `SERIAL_PROTOCOL`, `ARDUINO`, `BACKEND`, `BYPASS_MODE`, `TEMPERATURE_CONTROL`, `API_REFERENCE`, `FRONTEND`, `ARCHITECTURE_DECISIONS` (AD-02/03/04/07 superseded, new AD for always-live), `KNOWN_ISSUES`, `CURRENT_STATUS`, `CHANGELOG`, `TEST_RESULTS`. Run `graphify update .`.

**Acceptance criteria:**
- [ ] No doc describes SAFE/TEST modes or the LIVE toggle as current
- [ ] The protocol table matches the firmware

**Verification:**
- [ ] `grep -rn "SAFE" CLAUDE.md` shows only historical notes; the graph update succeeds

**Dependencies:** Checkpoint C · **Files:** `CLAUDE.md`, Obsidian notes · **Scope:** M (docs only)

---

## Checkpoint: Complete
- [ ] All spec success criteria met; owner signs off
- [ ] `CAPABILITY_MAP.md`: `always-live` marked done
