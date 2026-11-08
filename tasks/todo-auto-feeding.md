# Plan + tasks: auto-feeding

Spec: `SPEC-auto-feeding.md` (approved 2026-11-08).

## Approach
- **Logic first:** the decisions (trough validity, how much to add, which session is due) go in a pure module with unit tests, like `stage_schedule.py`.
- **Trough before the scheduler:** fix and commission the trough first (A2 + Checkpoint F-A), because the scheduler is useless without a trusted reading.
- **Locked until F-B:** the scheduler (A3) is built and deployed **locked**. The Pi commissioning flag and the toggle are turned on only after the supervised test F-B.

```
A1 feeding_schedule.py + unit tests ─┬─ A2 trough calibration (Pi + maintenance console) ── deploy ── Checkpoint F-A (owner)
                                     └─ A3 scheduler wiring (locked) ── A4 Feeding page + alerts ── deploy ── Checkpoint F-B (owner, supervised)
                                                                                                         └─ commission ── A5 docs
```

**Risks**
- **Overfeeding or underfeeding from a bad trough reading:** a strict validity check, and skip on any doubt.
- **Gate jam or empty hopper:** the trough is weighed after dispensing, with an alert; 3 faults turn automation off.
- **Double feeding after a restart:** sessions are persisted, with one attempt per (date, time).
- **Feeding during maintenance or while the Pi is offline:** refused (and the Arduino refuses too).

## A1: Decision logic and unit tests
**Status (2026-11-08): done.** `raspberry-pi/feeding_schedule.py` + `tests/auto-feeding/test_feeding_schedule.py`: 21 tests pass (`npm run test:auto-feeding`). Written test-first; two test-setup spacing mistakes were fixed in the tests, not the module. Notes:
- "Fresh" means the newest sample is < 5 s old, and the 10 s window must hold ≥ 5 numeric samples.
- Exactly 20 g is dispensed; 17.5 g is skipped.
- Skips and misses neither count toward nor break the fault streak; a dispensed or partial session resets it.

**Description:** new `raspberry-pi/feeding_schedule.py`, no hardware imports:
- `trough_valid(samples, now)`: 5 samples ≥, all < 5 s old, spread ≤ 25 g, median ≥ −25 g (clamped to 0).
- `session_need(target, trough_g, rate)`: SKIP_AT_TARGET, SKIP_TOO_SMALL (< 20 g), PARTIAL (10 s cap), or DISPENSE grams.
- `due_session(now, times, done)`: a time within the last 15 min that isn't done; older undone times → missed.
- `load_sessions` / `save_sessions` (atomic, last 7 days).
- `record_session(...)`.
- Fault streak → disable at 3.

**Acceptance:**
- [x] `npm run test:auto-feeding` (new script) passes: validity edge cases, need/skip/partial/min, due/missed at 14:59/15:00/15:15/15:16, restart without repeat, the fault streak.

**Files:** `raspberry-pi/feeding_schedule.py`, `tests/auto-feeding/test_feeding_schedule.py`, `package.json` · **Scope:** S

## A2: Trough calibration
**Status (2026-11-08): deployed** (Pi `app.py` `1422176d`, `feeding_schedule.py` `aaa1fec3`, backup `app_backup_before_trough_cal_*`; Worker `maintenance` `73172a56`). Live after deploy: trough `ESTIMATED -369.8 g`, feeding reading `not_commissioned` (expected until F-A).
- **Pi** (`app.py`):
  - `trough_raw_samples` buffer (filled by the serial parser), `trough_calibration.json`, `trough_grams()`, `trough_feeding_reading()` (A1 `trough_valid`);
  - `POST /api/bypass/trough-zero` (10 fresh readings, spread ≤ 2,000 counts, clears the factor);
  - `POST /api/bypass/trough-check {grams}` (100–5000 g, factor within ±10 % of 83.97);
  - `/api/feeding/weight` → `trough.status = CALIBRATED`, Pi grams, `firmwareGrams`, `feedingReading`;
  - `/api/bypass/status` → `trough`.
- **Gateway:** 2 maintenance routes (90 s timeout); maintenance now 14, main app 24 (none).
- **Console:** "Trough scale" card (live grams/raw, feeding-reading status, Zero trough / Check 500 g with confirm and about 20 s wait).
- **Checks:**
  - A2 harness 17/17 (accept/refuse paths, persisted, calibrated grams, unstable → invalid);
  - earlier harnesses updated to copy `feeding_schedule.py` (still pass);
  - gateway ALL PASS; both builds OK.
- **Deploy note:** the Pi now needs **`app.py`, `stage_schedule.py` and `feeding_schedule.py`**.
- **Firmware:** reads one raw sample every 2 s (no averaging). If F-A shows more than 25 g of noise, averaging in the firmware would be the fix (ask first).

**Description:**
- **Pi:**
  - `trough_calibration.json`;
  - `POST /api/bypass/trough-zero`: median of 10 raw readings, spread ≤ 2,000 counts;
  - `POST /api/bypass/trough-check {grams: 500}`: factor within ±10 % of 83.97;
  - trough grams computed on the Pi from raw readings (`troughCalibrated`, `troughGramsPi`) and kept in a 10 s sample buffer.
- **Gateway:** 2 maintenance routes.
- **Console:** a "Trough scale" section with the live raw value, calibrated grams, the two steps and instructions.

**Acceptance:**
- [x] Offline harness: zero / check accept and refuse cases.
- [x] Gateway tests (maintenance 14 routes, main app none).
- [x] Builds.

**Files:** `raspberry-pi/app.py`, `src/lib/server/pi-gateway.ts`, `tests/pi-gateway/*`, `maintenance-site/src/Console.tsx` · **Scope:** M · **Depends on:** A1 (validity helper)

### Checkpoint F-A (owner at the farm)
**Second attempt (2026-11-08 12:01–12:20):**
- **Zero and 500 g check:** both accepted. Factor **91.936 counts/g** (+9.5 % vs 83.97); zero 328,785.
- **5-min watch (12:04–12:09):** valid 30/30, but the median ranged 0–56 g (target ±25 g) → not passed.
- **Firmware averaging tried (hex `642dce8c`, flashed 12:16) → bad readings** (empty trough 300–760 g, ±100 g). **Rolled back** at about 12:18 to `flash_before_weight_avg_20261108_121604.hex`; repo source reverted. Not to be re-flashed until bench-tested.
- **With the old firmware, empty trough:** stdev 6 g but **+67…+90 g** at 12:18 and creeping up (0 at 12:01). **The zero drifts about 80 g in 17 min.** Likely mounting, cable tension, heat or debris; the owner is checking.
- **Pi:** the feeding reading uses a **30 s window** (about 15 readings, median) (`feeding_schedule.py` `c0ae7af2`, deployed).
- **Next:** the owner re-zeroes and leaves the trough untouched for 20 min, then we measure the drift. A3 is on hold until the trough is steady.

**First attempt (2026-11-08 11:48–11:49): Zero trough refused "unstable" every time.**
- Measured over 90 s with the trough still: single readings scatter ±14 g (stdev), and the max−min of any 10 readings is about 57 g. The medians of 10 readings stayed within about 13 g.
- **Fix:** stability is now judged by the **standard deviation ≤ 25 g** (Pi zero/check and `feeding_schedule.trough_valid`), and the value is the median.
- The console shows a 20 s countdown while measuring.
- 22 unit tests; A2 harness 17/17.
- Deployed: Pi `app.py` `71273028`, `feeding_schedule.py` `63656362`; Worker `maintenance` `00130af3`.

- [ ] Empty the trough, then **Zero trough** → accepted.
- [ ] 500 g in the trough, then **Check 500 g** → accepted, and the reading shows 500 ± 25 g.
- [ ] Empty trough again: the reading stays within ±25 g of 0 for 5 min.

## A3: Scheduler wiring (locked)
**Status (2026-11-08): built, not deployed.** In `app.py` (replaces the old in-memory `feed_schedule_worker`):
- `feed_schedule_tick()` (one pass, tested directly), `run_feeding_session()`, `feeding_sessions.json` via `_put_session()`.
- **Persistence:** the session is written as `fault/interrupted` **before** dispensing, then replaced, so a restart never repeats one.
- **Refusals** (recorded as skips): no stage/target, maintenance, controller not ready, feeding busy, no stage-compatible compartment.
- **Dispensing:** `session_plan` (rough-check); waits for the job; decreases the inventory estimate; trough re-read after 20 s → `check: low_rise` if it rose < 50 % of the grams sent.
- **Missed** only for slots after `automaticEnabledAt`. 3 faults → `automaticEnabled = false` (`automaticDisabledReason`).
- **Switch:** `POST /api/feeding/automatic {enabled}` (owner only, 423 `NOT_COMMISSIONED` unless `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED`). Saving the flock setup no longer resets it.
- **API:** `GET /api/feeding/sessions` (full status + today); `feedingStatus.automatic` in the snapshot.
- **Checks:** A3 harness 22/22 (owner and lock on the switch, full target and inventory, low rise, full → skip, unreadable → feeds, maintenance/busy → skip, missed + once, restart and interrupted not repeated, locked/off → nothing, 3 faults via the real tick → disabled); earlier harnesses still pass; `py_compile` OK.

**Rule change (owner, 2026-11-08):** use `feeding_schedule.session_plan()` (rough-check mode):
- full target each session;
- skip only if a valid trough reading is > target + 100 g;
- an unreadable trough still feeds and records it.

`session_need()` (precise mode) is kept for later. Checkpoint F-A is replaced by "the trough is calibrated and readable most of the time"; F-B checks the rough mode.

**Description:**
- Replace `feed_schedule_worker` with one using A1:
  - stage times and targets from `_feed_plan`;
  - trough from A2;
  - refusals recorded;
  - `feeding_sessions.json`;
  - after-dispense trough check (20 s) with a possible-jam alert;
  - inventory decrease;
  - fault streak → `automaticEnabled = false`.
- Remove the forced `automaticEnabled: False`. Owner-only `POST /api/feeding/automatic {enabled}`, accepted only with `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED` and a commissioned trough.
- `GET /api/feeding/sessions` (today + next).
- Add to the snapshot `feedingStatus`: `automatic {enabled, commissioned, lockedReason, next, lastResult}`.

**Acceptance:**
- [x] Offline harness (rough mode: full target):
  - a session dispenses the full target (precise `target − trough` deferred);
  - at target → skip;
  - invalid trough → skip plus alert data;
  - maintenance/offline → skip;
  - restart → no repeat;
  - 15-min window;
  - inventory decreases;
  - 3 faults → disabled;
  - the toggle is refused when not commissioned or not owner.
- [x] `py_compile`.

**Files:** `raspberry-pi/app.py` · **Scope:** M · **Depends on:** A1, A2

## A4: Feeding page and alerts
**Status (2026-11-08): built, not deployed.**
- **`AutoFeedingCard.tsx`** (top of the Feeding page): On/Off/Locked pill; a plain explanation; session amount, times, next session; Turn on/off (owner; locked button disabled; confirm); today's sessions with result, grams, reason and a low-rise hint. Polls `feeding/sessions` every 30 s.
- **`src/lib/feeding-reasons.ts`:** record type and reason texts.
- **Alerts:** auto-disabled (critical), fault, low rise, partial, unreadable, skipped (other than trough full), for the last session today; one id per session.
- **Gateway:** `feeding/sessions` (GET), `feeding/automatic` (POST, owner); main app 26 routes.
- **Checks:** gateway ALL PASS (helper reads 200, helper switch 403 `OWNER_ONLY`, owner 200); tsc 13 (unchanged); new files lint-clean; build OK.

**Description:**
- **Feeding page:**
  - Automatic feeding toggle (owner only) with status: locked (why) / on / off;
  - next session;
  - today's sessions (time, target, trough, dispensed, result, reason).
- **Alerts:** invalid trough skip, partial, possible jam/empty, auto-disabled.
- **New routes:** `feeding/sessions` (GET) and `feeding/automatic` (POST, owner) on the main app.
- **Polling:** none faster than 30 s.

**Acceptance:**
- [x] Gateway tests.
- [x] Build and lint (no new errors).

**Files:** `src/routes/feeding.tsx` (or a new `AutoFeedingCard.tsx`), `src/lib/live-alerts.ts`, `src/lib/server/pi-gateway.ts`, tests · **Scope:** M · **Depends on:** A3

**Deployed 2026-11-08 13:37–13:40:**
- **Pi:** `app.py` `8501c326` (backup `app_backup_before_auto_feeding_*`).
- **Pi:** `feeding_schedule.py` `7e4b92d0`. It was forgotten in the first step, which gave `/api/feeding/sessions` a 500 (`FULL_MARGIN_GRAMS` missing) for about 3 min; fixed.
- **Worker `app`:** `3aed9d26`.
- **Live check:** locked (`not_commissioned`), 157.5 g at 06/10/14/18, next 14:00; LIVE, GROWER.
- **Lesson:** deploy every changed Pi module together (`app.py`, `stage_schedule.py`, `feeding_schedule.py`).

### Checkpoint F-B (owner present, supervised)
**Run 2026-11-08 (owner at the farm):**
- **Setup:** temporary commissioning drop-in `/etc/systemd/system/poultrix.service.d/feeding-commissioned.conf`; config times set to a single test slot (backup `feeding_config_before_FB.json`). The owner turned the switch on at 13:44:23.
- **Test 1 (13:47):** the session was persisted as `interrupted`, gate 2 opened 1529 ms and the Arduino confirmed COMPLETED; recorded **dispensed 157.5 g** (`trough_unreadable`, fed the full amount); compartment 2 estimate 3000 → 2842.5 g; fault streak 0. **Grams not weighed:** the trough isn't removable.
- **Hole-by-hole test added (owner request):**
  - firmware `BYPASS:HOLE:<c>,<h>,<ms>` (one servo, maintenance only, same timer and limits);
  - Pi bypass action `hole`;
  - console Hole 1–5 buttons;
  - offline 7/7.
  - Flashed 14:22 (hex `fdbe0dad`, backup `flash_before_hole_test_*`), Pi `app.py` `e4f20bdd`, Worker `maintenance` `d7e90606`.
- **Gate rate measured:**
  - holes one at a time, 5 × 1.53 s caught = **250 g** (kitchen scale);
  - all 5 together, hopper drop **250 g / 1.529 s** (13:47) and **233 g / 1.534 s** (14:40).
  - So compartment 2 delivers about **157.7 g/s**, not 103.00: sessions were giving about 240 g instead of 157.5 g.
  - **`FEED_RATES[2] = 157.7`** (owner-approved), deployed: Pi `app.py` `41649071`; frontend stale rate text removed (Worker `app` `ad066385`). A 157.5 g session is now a 0.999 s gate.
  - Compartment 1 (101.39) is not re-measured yet.
- **Confirmation at 157.7 g/s:** a 158 g target (1.002 s) gave **177 g** (+12 %). With 300 g (1.902 s) → **289 g**. A linear fit over the 4 points gives **grams = 52.2 + 124.1 × seconds** (residuals within ±9 g): a fixed amount per opening while the servos move.
  - Implemented as `FEED_OFFSETS[2] = 52.2`, `FEED_RATES[2] = 124.1`, with `feeding_schedule.gate_seconds/gate_grams` used by `_feed_inputs`, the job estimate, gate events, the schedule test, `session_plan`/`session_need` (`below_minimum_gate` when < 0.1 s).
  - A 157.5 g session is now a **0.849 s** gate; the minimum is about 65 g.
  - Tests: 30 unit tests, all 6 harnesses.
  - Deployed: Pi `app.py` `24e229d3`, `feeding_schedule.py` `bbbab912`.
- **Next:** one confirmation dispense at the new model (hopper drop ≈ 158 g?); Test 2 (500 g weight → skip, or feed if unreadable); Test 3 (maintenance open → skip); then restore times and decide on commissioning.

- [ ] Set the Pi commissioning flag temporarily, with a test session time a few minutes ahead. Empty trough → about the target is dispensed; weigh it on a kitchen scale.
- [ ] Trough above the target → skipped with a reason.
- [ ] Maintenance open at the session time → skipped.
- [ ] Then the owner decides whether to leave the flag and the toggle on.

## A5: Docs
CLAUDE.md, AGENTS.md (if rules change), vault (FEEDING_SYSTEM, API_REFERENCE, AD-28, CURRENT_STATUS, CHANGELOG, TEST_RESULTS), CAPABILITY_MAP · **Scope:** S
