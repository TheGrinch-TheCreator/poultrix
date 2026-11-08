# Spec: auto-feeding

Status: **DONE 2026-11-08** (Checkpoint F-B passed; commissioned and switched on). Approved 2026-11-08 (owner: Q1 Zero trough + 500 g check on the maintenance site, Q2 skip + alert, Q3 cap + alert, Q4 default times, Q5 15 min late window, Q7 keep 35/90/135; Q6 unanswered → owner account only, changeable). Plan and tasks: `tasks/todo-auto-feeding.md`. Module `auto-feeding` in `CAPABILITY_MAP.md` (depends on `always-live` ✅ and `stage-schedule` ✅; ships only with `remote-access` login protection ✅).

## Objective
Unattended scheduled feeding for the **confirmed stage** (owner requirement 2):
- **dispense = session target − trough weight**, never below 0;
- **skip the session** if the trough already holds ≥ the target;
- keep the existing **10 s per session** gate cap (≈ 1 kg).

### User stories
1. As the owner, I turn on **Automatic feeding** once. At each session time, the Pi tops the trough up to the session target for today's stage and bird count.
2. If the birds didn't eat the last portion, the Pi adds only the difference, or nothing.
3. If something is wrong (the trough reading is bad, the hopper compartment is empty or wrong for the stage, the Arduino is offline, maintenance is open), the session is skipped. I get an alert saying why. Nothing is dispensed on a guess.
4. I can see today's sessions on the Feeding page: done, skipped (why), next time, grams.

## Facts (verified 2026-11-08)
- **Session target:** `_feed_plan()` computes `birdCount × FEED_FIXED_DAILY_GRAMS[stage] / FEED_SESSIONS[stage]` with the constants:

  | Stage | g/bird/day | Sessions/day | Default times |
  |---|---|---|---|
  | Starter | 35 | 6 | 06, 09, 12, 15, 18, 21 |
  | Grower | 90 | 4 | 06:00, 10:00, 14:00, 18:00 |
  | Finisher | 135 | 4 | 06:00, 10:00, 14:00, 18:00 |

  Today (7 birds, Grower) → **157.5 g per session**.
- **Dispensing:** `_start_feed_job()` / `_feed_job_run()` already do timed dispensing.
  - Duration = grams / measured rate (compartment 1 = 101.39 g/s, 2 = 103.00 g/s), 10 s cap.
  - The Arduino acknowledges each gate (`FEED:DISPENSE` → COMPLETED) and the job stops on any fault.
  - The Arduino refuses `FEED:DISPENSE` while the Pi is offline or in maintenance.
- **Compartment:** the inventory picks it (`selectedCompartment`, stage-compatible and above the low threshold). Today: compartment 2 (Integra 2, Grower/Finisher). Compartment 1 is Booster, Starter only.
- **Scheduler today:** `feed_schedule_worker()` already exists, but it is **locked twice**:
  - it needs the Pi env `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED` (not set);
  - it needs the saved `automaticEnabled`, which `_read_feed_config()` and the POST **always force to False**.

  It also **doesn't subtract the trough weight**, remembers attempted sessions only in memory (a restart in the same minute could repeat one), and never replays a missed session.
- **Trough load cell is not usable yet:**
  - Live readings: **−263 g and −324 g two seconds apart** (raw 350,512–355,606), status `ESTIMATED`.
  - `FEED_TROUGH_CALIBRATED` (env) is not set.
  - The calibration in code (zero 377,696 raw, 83.97 counts/g) clearly no longer matches: the zero has drifted, and the noise is about ±30 g.
- **Hopper:** 2,216 g `ESTIMATED`. Inventory stock is tracked as estimates (3,000 g each) and **is not decreased after dispensing** (open TODO).

## Rule change 2026-11-08 (owner, after Checkpoint F-A): "rough trough check" mode
F-A showed the trough load cell is **not accurate enough** for `target − trough`:
- the empty-trough zero drifts by **±50–80 g within 20–30 min**, in both directions;
- the noise is ±10–25 g.

Until the scale is fixed, the owner chose **option 2 + (a)**:
- **Dispense the full session target** each session (10 s cap; partial + alert if more is needed).
- **Skip only if the trough is clearly full:** a *valid* trough reading **> target + 100 g** (`FULL_MARGIN_GRAMS`; larger than the drift seen) → skip "trough already full".
- **Unreadable trough** (invalid: unstable, stale, not calibrated): **feed the full target anyway** and record "trough unreadable", with an info alert. This replaces the earlier "skip + alert" (decision 2), which applied to the precise mode.
- The precise `target − trough` logic (`session_need`) stays in the code for when the scale passes F-A again (a later owner decision).

## Design
1. **Trough reading for decisions** (`trough_reading_for_feeding()`). Collect the trough readings of the last 10 s (5 samples). The reading is **valid** only if:
   - all are fresh (< 5 s old);
   - the spread is ≤ 25 g;
   - the median is ≥ −25 g (a small negative is clamped to 0);
   - the trough is commissioned (Q1).

   Otherwise the result is `invalid` and **the session is skipped** (Q2).
2. **Session decision** (pure function, unit-tested like `stage_schedule.py`):
   ```
   need = target - trough
   need <= 0          -> SKIP "trough already at target"
   need < 20 g        -> SKIP "less than 20 g needed" (below gate resolution)
   need/rate > 10 s   -> dispense the 10 s cap, flag PARTIAL (Q3)
   else               -> dispense need
   ```
3. **Scheduler** (replaces `feed_schedule_worker`):
   - **Session times:** today's times for the confirmed stage (defaults above; Q4).
   - **Late start:** a session runs if the Pi reaches it within **15 min** after its time (Q5); later ones are skipped as `missed`.
   - **Refusal reasons**, each recorded and a skip: Arduino not ready, a feed job or gate already busy, no stage-compatible compartment. (Maintenance no longer blocks feeding: owner decision 2026-11-08.)
   - **Persistence:** sessions are saved in `feeding_sessions.json` (`date, time, stage, target, trough, dispensed, result, reason`, last 7 days), so a restart never repeats one.
   - **After a dispense:** wait 20 s, read the trough again and record `troughAfter`. If it rose by less than 50 % of the grams sent → alert "Feed may not have reached the trough (empty hopper or jammed gate?)". No retry.
   - **Inventory:** decrease the compartment's estimated stock by the grams sent.
4. **Enable and commission:**
   - Remove the forced `False`.
   - `automaticEnabled` is set by a toggle on the Feeding page (Q6), only accepted when the Pi is commissioned (`POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED`, set on the Pi after Checkpoint F-B).
   - The toggle is turned off automatically after **3 consecutive faults** (not skips), with an alert.
   - **Owner account only** (Q6 default, same `POULTRIX_OWNER_EMAILS` check as system power). Other accounts see the status but can't change it.
5. **Trough commissioning** (Q1, approved): two steps on the maintenance site.
   1. **Zero trough** (trough empty): the Pi takes the median raw of 10 readings, which must agree within ±2,000 counts (≈ 25 g). That becomes the zero.
   2. **Check 500 g** (the 500 g reference in the trough): the Pi computes counts/g = (raw − zero) / 500. It's accepted only within ±10 % of the previous two-point factor (83.97), so a wrong weight can't be stored.

   Both are stored on the Pi in `trough_calibration.json` (`zeroRaw`, `countsPerGram`, `calibratedAt`). From then on the Pi computes trough grams from the raw value itself (the firmware's `ESTIMATED` grams are ignored for feeding), so there are no calibration constants in the frontend. The trough counts as commissioned when this file exists and both steps passed.
6. **UI:**
   - **Feeding page:**
     - Automatic feeding toggle (with status: commissioned / locked and why);
     - today's sessions table (time, target, trough, dispensed, result/reason);
     - next session.
   - **Alerts:** skipped-because-invalid-trough, partial, possible jam/empty, auto-disabled.
   - All from existing endpoints. `feeding/config` and `feeding/status` are extended, with no new fast polls (Feeding page every 30 s).
7. **Gateway:** extend existing routes. Possibly one new route `feeding/sessions` (GET) on the main app, and `bypass/trough-zero` (POST) on the maintenance site.

## Commands
```
npm run test:auto-feeding        # new: python -m unittest discover -s tests/auto-feeding -v
npm run test:gateway
npm run build && npm run lint
python -m py_compile raspberry-pi/app.py raspberry-pi/feeding_schedule.py
```

## Testing strategy
- **Unit tests** (`tests/auto-feeding/`, pure module `raspberry-pi/feeding_schedule.py`):
  - trough validity (stale, noisy, negative);
  - need / skip / partial / min-grams;
  - session due within 15 min;
  - missed;
  - persistence and no repeat;
  - 3 faults → disable.
- **Offline harness:** stubbed serial with an Arduino that acknowledges gates; trough samples scripted.
- **Checkpoint F-A** (owner at the farm): zero the trough, check 500 g, watch readings stable within ±25 g for 5 min.
- **Checkpoint F-B** (owner present, supervised):
  - one session forced at a time a few minutes ahead, with an empty trough → about the target is dispensed;
  - one with the trough above target → skipped;
  - check grams on a kitchen scale.
- **Commissioning:** only after F-B passes, set `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED` and turn the toggle on.

## Boundaries
- **Always:**
  - skip on any doubt;
  - keep the 10 s cap and the Arduino acknowledgement;
  - record every session and reason;
  - feed only for the confirmed stage from a stage-compatible compartment.
- **Ask first:**
  - changing g/bird/day, the session counts or the times;
  - retrying a failed session;
  - any firmware change.
- **Never:**
  - dispense when the trough reading is invalid;
  - feed with the Pi seen offline (maintenance no longer blocks feeding, owner 2026-11-08);
  - replay old missed sessions;
  - add calibration constants in the frontend;
  - enable automation without the Pi commissioning flag.

## Success criteria
1. With the toggle on and the Pi commissioned, every session time either dispenses `target − trough` (≤ 10 s) or records a skip with a clear reason. Nothing runs twice, even after a restart.
2. A trough at or above target → no dispense. An invalid trough reading → no dispense plus an alert.
3. Faults alert, and 3 in a row turn automation off.
4. Inventory estimates go down by the grams sent.
5. F-A and F-B pass with the owner. Tests, build and lint pass.

## Decisions (owner, 2026-11-08)
1. Trough: Zero trough + 500 g check on the maintenance site, stored on the Pi.
2. ~~Invalid trough reading: skip the session and alert.~~ Superseded 2026-11-08 by the rough-check mode: feed the full target and record "trough unreadable".
3. Need > 10 s cap: dispense the cap and alert "partial".
4. Session times: the defaults (Starter 06/09/12/15/18/21; Grower and Finisher 06/10/14/18).
5. Pi offline at session time: run it if back within 15 min, otherwise missed.
6. (Not answered) Toggle: owner account only, changeable later.
7. Feed amounts: keep 35 / 90 / 135 g/bird/day.
8. **Maintenance never blocks feeding** (owner, during F-B). Scheduled and manual feeds run while the maintenance site is open. Only a running maintenance gate/hole test blocks them (same servos). Leaving maintenance never cuts a feed that is running. Firmware and Pi changed accordingly.
9. **Gate model** for compartment 2 (measured in F-B): 52.2 g per opening + 124.1 g/s.
