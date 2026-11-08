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
**Description:** new `raspberry-pi/feeding_schedule.py`, no hardware imports:
- `trough_valid(samples, now)`: 5 samples ≥, all < 5 s old, spread ≤ 25 g, median ≥ −25 g (clamped to 0).
- `session_need(target, trough_g, rate)`: SKIP_AT_TARGET, SKIP_TOO_SMALL (< 20 g), PARTIAL (10 s cap), or DISPENSE grams.
- `due_session(now, times, done)`: a time within the last 15 min that isn't done; older undone times → missed.
- `load_sessions` / `save_sessions` (atomic, last 7 days).
- `record_session(...)`.
- Fault streak → disable at 3.

**Acceptance:**
- [ ] `npm run test:auto-feeding` (new script) passes: validity edge cases, need/skip/partial/min, due/missed at 14:59/15:00/15:15/15:16, restart without repeat, the fault streak.

**Files:** `raspberry-pi/feeding_schedule.py`, `tests/auto-feeding/test_feeding_schedule.py`, `package.json` · **Scope:** S

## A2: Trough calibration
**Description:**
- **Pi:**
  - `trough_calibration.json`;
  - `POST /api/bypass/trough-zero`: median of 10 raw readings, spread ≤ 2,000 counts;
  - `POST /api/bypass/trough-check {grams: 500}`: factor within ±10 % of 83.97;
  - trough grams computed on the Pi from raw readings (`troughCalibrated`, `troughGramsPi`) and kept in a 10 s sample buffer.
- **Gateway:** 2 maintenance routes.
- **Console:** a "Trough scale" section with the live raw value, calibrated grams, the two steps and instructions.

**Acceptance:**
- [ ] Offline harness: zero / check accept and refuse cases.
- [ ] Gateway tests (maintenance 14 routes, main app none).
- [ ] Builds.

**Files:** `raspberry-pi/app.py`, `src/lib/server/pi-gateway.ts`, `tests/pi-gateway/*`, `maintenance-site/src/Console.tsx` · **Scope:** M · **Depends on:** A1 (validity helper)

### Checkpoint F-A (owner at the farm)
- [ ] Empty the trough, then **Zero trough** → accepted.
- [ ] 500 g in the trough, then **Check 500 g** → accepted, and the reading shows 500 ± 25 g.
- [ ] Empty trough again: the reading stays within ±25 g of 0 for 5 min.

## A3: Scheduler wiring (locked)
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
- [ ] Offline harness:
  - a session dispenses `target − trough`;
  - at target → skip;
  - invalid trough → skip plus alert data;
  - maintenance/offline → skip;
  - restart → no repeat;
  - 15-min window;
  - inventory decreases;
  - 3 faults → disabled;
  - the toggle is refused when not commissioned or not owner.
- [ ] `py_compile`.

**Files:** `raspberry-pi/app.py` · **Scope:** M · **Depends on:** A1, A2

## A4: Feeding page and alerts
**Description:**
- **Feeding page:**
  - Automatic feeding toggle (owner only) with status: locked (why) / on / off;
  - next session;
  - today's sessions (time, target, trough, dispensed, result, reason).
- **Alerts:** invalid trough skip, partial, possible jam/empty, auto-disabled.
- **New routes:** `feeding/sessions` (GET) and `feeding/automatic` (POST, owner) on the main app.
- **Polling:** none faster than 30 s.

**Acceptance:**
- [ ] Gateway tests.
- [ ] Build and lint (no new errors).

**Files:** `src/routes/feeding.tsx` (or a new `AutoFeedingCard.tsx`), `src/lib/live-alerts.ts`, `src/lib/server/pi-gateway.ts`, tests · **Scope:** M · **Depends on:** A3

### Checkpoint F-B (owner present, supervised)
- [ ] Set the Pi commissioning flag temporarily, with a test session time a few minutes ahead. Empty trough → about the target is dispensed; weigh it on a kitchen scale.
- [ ] Trough above the target → skipped with a reason.
- [ ] Maintenance open at the session time → skipped.
- [ ] Then the owner decides whether to leave the flag and the toggle on.

## A5: Docs
CLAUDE.md, AGENTS.md (if rules change), vault (FEEDING_SYSTEM, API_REFERENCE, AD-28, CURRENT_STATUS, CHANGELOG, TEST_RESULTS), CAPABILITY_MAP · **Scope:** S
