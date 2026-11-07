# Implementation Plan: always-live

Spec: `SPEC-always-live.md` (approved 2026-11-06) · Map: `CAPABILITY_MAP.md` · Tasks: `tasks/todo.md`

## Overview
Remove SAFE/TEST modes from firmware, Pi and UI. The Arduino boots into automatic climate control and keeps it running when the Pi is offline (it only reports `PI:OFFLINE` and stops feeding). Leaving bypass returns to automatic control. The Pi drops its LIVE-recovery machinery, and a bypass session survives a serial hiccup (paused + Resume). The header shows status instead of a LIVE/SAFE toggle.

## Architecture Decisions
- **Firmware first, Pi second.** `get_status()` derives `operatingStatus` from `mode == "live"`, and the new firmware keeps sending `MODE_STATUS:LIVE`, so new firmware works with the *current* Pi code:
  - the old recovery worker just fails harmlessly ("NO_STABLE_SAFE_CONNECTION");
  - feeding still sees `mode == "live"`.

  The reverse (new Pi, old firmware) would leave the Arduino in SAFE forever. **Never deploy the Pi change before the firmware.**
- **Keep `MODE_STATUS:LIVE` in the protocol** as a compatibility constant, plus a new `PI_STATUS:ONLINE|OFFLINE`. This avoids touching the telemetry Worker and the UI's status logic.
- **Pi-offline detection lives in the firmware** (`SYS:PING` watchdog, 10 s, unchanged timing). The Pi learns the Arduino's view from `PI_STATUS`.
- **Bypass token is no longer revoked on serial loss.** Manual control is paused instead and overrides are cleared. Safety comes from the Arduino's own 10 s maintenance timeout, which now returns to automatic control.
- **No new dependencies, no new files** except docs. `app.py` stays one file.

## Dependency graph
```
T1 diagnose hiccup (Pi logs)  ── informs hardware follow-up, blocks nothing
T2 firmware: single automatic mode
 └─ T3 firmware: Pi-offline behavior
     └─ T4 firmware: maintenance exit → automatic
         └─ [Checkpoint A: compile + bench + flash; old Pi still works]
             └─ T5 Pi: remove recovery + mode routes
                 └─ T6 Pi: bypass survives hiccup; readiness checks
                     └─ [Checkpoint B: integrated Pi + Arduino]
                         ├─ T7 UI: header status pill
                         └─ T8 UI: bypass page paused/resume
                             └─ [Checkpoint C: lint/tsc/build + LAN UI]
                                 └─ T9 docs + graph update
```
T7 and T8 are independent of each other. T1 can run any time, ideally before T2 is flashed (it reproduces the bug on the current code).

## Task List
See `tasks/todo.md` for full acceptance criteria.

### Phase 0: Diagnose
- [ ] T1: Capture Pi logs during bypass to identify the hiccup cause

### Phase 1: Firmware (one file, `poultrix_arduino.ino`)
- [ ] T2: Single automatic mode; boot into control; remove SAFE/TEST/MODE commands
- [ ] T3: Pi-offline behavior (keep control, close gates, LCD/LED, `PI_STATUS`)
- [ ] T4: Bypass exit/timeout returns to automatic control
### Checkpoint A: firmware compiles, bench tests pass, flashed; current Pi still works

### Phase 2: Pi (`raspberry-pi/app.py`)
- [ ] T5: Remove the recovery system and mode routes; reconnect without mode commands
- [ ] T6: Bypass survives serial loss (pause + Resume); feeding/AI readiness uses connection status
### Checkpoint B: integrated tests on the Pi

### Phase 3: Frontend
- [ ] T7: Header LIVE/SAFE toggle → read-only status pill
- [ ] T8: Bypass page wording and paused/Resume after a hiccup
### Checkpoint C: static checks + UI check on the LAN

### Phase 4: Docs
- [ ] T9: CLAUDE.md, Obsidian notes, `graphify update .`
### Checkpoint: Complete

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Pi updated before firmware → Arduino stuck in SAFE | High | Deploy order fixed; Checkpoint A must be passed and flashed first |
| Heater now runs with no Pi supervision and no over-temperature cutoff | High | Still stops on an invalid DHT reading; recommend a physical thermal cutoff (separate work); bench test heater cycling in T2 |
| The hiccup is an Arduino brownout/reset (servo power) | Med | T1 confirms. After this plan a reset only means brief "Pi offline" with control resuming at boot. Hardware fix (separate servo PSU) is recommended, not in code scope |
| Gate open when the Pi drops | Med | T3 closes gates on `PI:OFFLINE`; gate timers are already capped at 10 s |
| Firmware RAM/flash after edits | Low | IDE Verify reports memory; removing TEST code shrinks it |
| No automated tests | Med | Bench + integrated manual tests with exact steps; results recorded in Obsidian `TEST_RESULTS` |

## Pi runtime (from owner, 2026-11-06)
- systemd unit `poultrix.service`; WorkingDirectory `/home/raspberry/poultrix-api`; ExecStart `/home/raspberry/poultrix-api/venv/bin/python /home/raspberry/poultrix-api/app.py`.
- Logs: `journalctl -u poultrix`. Deploy = copy `raspberry-pi/app.py` to `/home/raspberry/poultrix-api/app.py`, then `sudo systemctl restart poultrix`.
- So `feeding_config.json`, `feed_inventory.json` and `best.pt` live in `/home/raspberry/poultrix-api/` on the Pi.

## Bench testing
The owner bench-tests the firmware with the Pi disconnected and mains loads disconnected, using `tasks/bench-test-always-live.md`. Checkpoint A requires recorded results; nothing is assumed to pass.
