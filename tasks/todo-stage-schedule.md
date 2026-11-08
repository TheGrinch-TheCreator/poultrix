# Plan + tasks: stage-schedule

Spec: `SPEC-stage-schedule.md` (approved 2026-11-08).

## Approach
Write the day and schedule rules first as a pure Python module with unit tests. Then wire them into the Pi, deploy to the Pi, and check it there before any UI change. The frontend only displays what the Pi reports. Docs and the rule change in AGENTS.md / CLAUDE.md come last, in the same branch.

```
S1 stage_schedule.py + unit tests ── S2 app.py wiring ── Pi deploy ── Checkpoint S-A (Pi smoke)
                                                                        └─ S3 frontend (Flock, AI Stage, Alerts) ── deploy ── S4 docs ── Checkpoint S-B (owner)
```

**Risks**
- **Restart mid-window:** the attempt is persisted with the date and cycle count, so a restart resumes the count and never starts a second window.
- **Clock/timezone:** all day maths go through one `manila_today()` helper; the tests cover the midnight boundary.
- **Apply fails** (Arduino offline, maintenance, feeding busy): the attempt stays open; retry in the same window, then the next day.
- **Old behaviour removed** (5-minute cycles all day, any-direction transitions): this is the intended change. The AI Stage page text changes with it.

## S1: Schedule logic and unit tests
**Status (2026-11-08): done.** `raspberry-pi/stage_schedule.py` + `tests/stage-schedule/test_stage_schedule.py`: 19 tests pass (`npm run test:stage-schedule`). Written test-first (red: module missing, then green). Falls back to a fixed UTC+8 zone when the OS has no tz database (Windows dev machines); the Pi uses the real `Asia/Manila` zone.

**Description:** new `raspberry-pi/stage_schedule.py`, no hardware imports.
- Constants: `GROWER_FROM_DAY = 11`, `FINISHER_FROM_DAY = 25`, `DAILY_CHECK_TIME = "10:00"`, `DAILY_MAX_CYCLES = 6`, `TZ = Asia/Manila`.
- `batch_day(start, today)`: `None` for no date or a future date.
- `allowed_targets(day, current)`: forward only, day-gated. Still Starter on day ≥ 25 → Grower or Finisher.
- `window_due(now, day, current, attempt)`: true when targets exist, `now ≥ 10:00` today, and today's attempt isn't finished.
- `record_cycle(attempt, today, result)`: increments cycles; finishes as `confirmed`, or as `not_confirmed` at 6 cycles.
- `schedule_status(...)`: the `schedule` object from spec §6 (phase, allowedTargets, nextCheckAt, overdueDays, lastAttempt).
- `load_attempt(path)` / `save_attempt(path, attempt)`: JSON with an atomic write; a corrupt file counts as "no attempt".

**Acceptance:**
- [x] Tests for:
  - day 10/11 and 24/25 gates;
  - forward-only rules (Grower → no Starter, Finisher → nothing);
  - Starter on day 26 → Grower and Finisher allowed;
  - no date and a future date;
  - Manila midnight;
  - window before and after 10:00;
  - 6-cycle limit;
  - confirmed attempt not re-run;
  - next day re-run;
  - corrupt attempt file;
  - `overdueDays` (day 11 before the first check → 0, day 11 after a failed check → 1, day 12 before its check → 1).
- [x] `python -m unittest discover -s tests/stage-schedule -v` passes (19/19).

**Files:** `raspberry-pi/stage_schedule.py`, `tests/stage-schedule/test_stage_schedule.py` · **Scope:** S

## S2: Pi wiring in `app.py`
**Status (2026-11-08): deployed to the Pi**, Checkpoint S-A in progress.
- Edits: `stage_schedule` import, `schedule_attempt` (loaded from `stage_schedule.json`), `evaluate_stage_transition(..., scheduled)`, `run_ai_cycle(scheduled)`, `run_scheduled_check()`, `ai_worker()` (window only, 30 s poll), `start_new_batch()` on a changed date, `schedule` in `/api/ai/status`.
- Manual and maintenance cycles no longer reset the scheduled candidate on tie or no frames.
- Offline harness (stubbed hardware, fake clock): 28/28 checks.
- On the Pi:
  - backup `app_backup_before_stage_schedule_*.py`, sha `5cd6dce8` (app) / `180a5392` (stage_schedule);
  - `schedule` shows day 29, `grower_check`, 18 days overdue (stage still STARTER);
  - Analyze now → Grower 90.3 %, `manual_check_only`, stage unchanged;
  - camera 200; `snapshot.ai.schedule` present.
- Note: a restart mid-window keeps the cycle count (persisted) but the in-memory 3-in-a-row candidate starts again.

**Description:**
- `ai_worker()`:
  - Every 30 s, check `window_due()`. Inside the window, run a cycle every `AI_INTERVAL_SECONDS` (5 min) and record each result.
  - Outside the window, no automatic cycles.
  - The maintenance stage override still pauses it.
- `evaluate_stage_transition(detected, confident, scheduled)`:
  - It counts only when `scheduled` is true and the detection is in `allowed_targets()`.
  - New statuses: `no_batch_date`, `not_allowed_yet`, `backward_ignored`, `manual_check_only`.
  - The 3 consecutive cycles and the safe apply are unchanged. The candidate resets when the window ends.
- `POST /api/ai/classify`: runs the cycle with `scheduled=False` (camera check only).
- `POST /api/feeding/config`: when the saved `batchStartDate` changes and the new day is 1–10, apply `STARTER` (safe apply), clear the attempt and log `[AUDIT] new batch`.
- `GET /api/ai/status` (and therefore `/api/snapshot`): adds `schedule`.
- Pi deploy:
  - back up `app.py`;
  - copy `app.py` and `stage_schedule.py`;
  - restart `poultrix`.

**Acceptance:**
- [ ] `python -m py_compile raspberry-pi/app.py raspberry-pi/stage_schedule.py`; S1 tests still pass
- [ ] On the Pi, `/api/ai/status` shows `schedule` with the right `batchDay` and `phase`.
- [ ] The log shows no automatic cycles outside the window.
- [ ] Analyze now returns `transition.status = manual_check_only`, and the stage is unchanged.

**Files:** `raspberry-pi/app.py` · **Scope:** M · **Depends on:** S1

### Checkpoint S-A (Pi smoke test, done by me over SSH)
- [ ] `schedule` is correct for the current batch date.
- [ ] Test window: a temporary `DAILY_CHECK_TIME` a few minutes ahead, reverted after.
  - The window runs, records cycles, and finishes `confirmed` or `not_confirmed`.
  - After a restart, `stage_schedule.json` is respected and the window is not run twice.
- [ ] Climate control, the camera and the maintenance site keep working.

## S3: Frontend
**Status (2026-11-08): deployed** (Worker `app` version `78f56c8f`).
- New `src/components/poultrix/StageSchedule.tsx`: `BatchDaySummary` (Day N, phase, next check, overdue notice, last check) and `BatchTimeline` (3 stages, "from day", Done/Current/Overdue/Upcoming).
- `live-hardware.ts`: `StageSchedule` type on `AI.schedule`.
- `flock.tsx`: uses both.
- `ai-stage.tsx`: new help text, "Camera check (doesn't change the stage)" button, "From day N" from the API.
- `live-alerts.ts`: `stage-overdue-<STAGE>-<lastAttemptDate>` warning; `finisher-ack` alert removed.
- `stage-requirements.ts`: `referenceDays` removed.
- `FeedingPlanner.tsx`: notice after saving (new batch → Starter, or why not), refreshes the snapshot, footer text.
- Checks: build ✅; gateway tests ALL PASS; tsc 15 errors (16 before, none new); non-formatting lint errors in touched files unchanged (8); the new file is lint-clean. No new polls.

**Description:**
- **Types:** `useAI` gets a typed `schedule` field (`src/lib/live-hardware.ts`).
- **Flock page:**
  - Batch overview: Day N (or "Set the batch start date below"), phase, next check, overdue notice.
  - Batch timeline: the 3 stages with "from day 1 / 11 / 25" and the last attempt result.
  - Only real data, "—" otherwise.
- **AI Stage page:**
  - Help text: stage changes happen at the daily 10:00 check.
  - The button reads "Camera check (doesn't change the stage)".
  - The "Reference days" label shows the start days from the API.
- **Alerts:** `stage-overdue-<STAGE>-<lastAttemptDate>` warning when `overdueDays > 0`. Remove the obsolete `finisher-ack` alert.
- No new polls; everything comes from the snapshot.

**Acceptance:**
- [ ] `npm run build`, `npm run lint`, `npm run test:gateway` pass.
- [ ] On the deployed app (after your "deploy"), the Flock page shows the real Day N and phase.

**Files:** `src/lib/live-hardware.ts`, `src/routes/flock.tsx`, `src/routes/ai-stage.tsx`, `src/lib/live-alerts.ts`, `src/lib/stage-requirements.ts` · **Scope:** M · **Depends on:** S2

## S4: Docs
**Description:**
- **AGENTS.md and CLAUDE.md:** the new stage rule, AI cycle timing, `stage_schedule.py`, the Pi deploy now copies two files.
- **Vault:**
  - AI/stage feature note;
  - AD-23 (day-gated, forward-only, AI still confirms);
  - CURRENT_STATUS, CHANGELOG, TEST_RESULTS, API_REFERENCE (`schedule` object).
- **Status:** CAPABILITY_MAP and this file.
- **Graph:** `graphify update .`

**Acceptance:**
- [ ] No doc still says age/day is "reference-only".

**Files:** `AGENTS.md`, `CLAUDE.md`, `CAPABILITY_MAP.md`, vault notes · **Scope:** S · **Depends on:** S3

### Checkpoint S-B (owner)
- [ ] With a day-11+ batch, a confirmed Grower switches the Arduino and the LCD.
- [ ] A Starter detection while in Grower does not move the stage back.
- [ ] Analyze now does not change the stage.
- [ ] An overdue check shows on the Flock page and in Alerts.
