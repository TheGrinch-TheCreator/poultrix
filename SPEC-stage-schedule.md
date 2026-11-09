# Spec: stage-schedule

Status: addendum §10 (thesis-panel schedule, observe-only pre-checks) **APPROVED 2026-11-09** (owner: decisions 1–5 yes), implemented the same day. Base spec **APPROVED 2026-11-08** (owner: Q1 yes, Q2 yes, Q3 yes, Q4 yes, Q5 → also in Alerts). Plan and tasks: `tasks/todo-stage-schedule.md`. Module `stage-schedule` in `CAPABILITY_MAP.md` (no dependencies; `auto-feeding` depends on it).

## Objective
Make the **batch day decide when the AI analyses the flock and which stage it may confirm**. The AI still makes the confirmation.
- **Day 1** is the batch start date entered on the **Flock** page.
- **Starter** applies from the start of the batch.
- **Grower** may be confirmed from **day 11**. The analysis is retried **once a day** until the AI confirms Grower.
- **Finisher** may be confirmed from **day 25**, retried once a day the same way.
- **Forward only:** Starter → Grower → Finisher. The AI can never move the stage backwards.
- **No fallback by day:** if the AI never confirms a stage, the stage stays where it is. The owner sees that it is overdue, but the day alone never changes it.

Why: today the AI runs every 5 minutes for the whole batch and can move the stage in any direction (`evaluate_stage_transition`, `app.py:1236`). A bad camera frame sequence on day 3 could set Finisher, or move Finisher back to Starter. That gives the wrong temperature, lighting and (with `auto-feeding`) the wrong feed amount.

### User stories
1. As the owner, I enter the batch start date on the Flock page. The page then shows "Day N", the current stage, and when the next stage check is due.
2. On days 1–10 nothing changes the stage from Starter, whatever the camera sees.
3. From day 11 the Pi checks once a day. When the AI is sure it sees Grower, the house switches to Grower settings. If it's not sure, the Pi tries again the next day.
4. From day 25 the same happens for Finisher.
5. If day 14 comes and Grower still isn't confirmed, I see "Grower check overdue: not confirmed yet (last tried today 10:00, result: Starter 72%)" so I can look at the camera or the lighting.

## Facts (verified 2026-11-08)
- **Batch date:** `feeding_config.json` holds `batchStartDate` (ISO date) and `birdCount`. It's saved through `POST /api/feeding/config` from `FeedingPlanner` (shown on the Flock page, `flock.tsx:111`). It must not be in the future. `_feed_plan()` already computes `batchAgeDays` = Manila today − start + 1.
- **AI worker:** `ai_worker()` (`app.py:1597`) runs `run_ai_cycle()` every `AI_INTERVAL_SECONDS` = 300, unless maintenance has a stage override.
  - One cycle samples 30 frames over 30 s and takes the majority vote. It counts as confident at ≥ 60 % confidence with enough valid frames.
- **Transition rule today:** `evaluate_stage_transition()` accepts **any pair** of stages after 3 consecutive confident cycles (`AI_TRANSITION_CONFIRMATIONS_REQUIRED`), then calls `apply_confirmed_stage_to_arduino()`.
  - The apply step sends `STAGE:<X>` only if the controller is ready, maintenance is off and no feed is dispensing. It then waits for the Arduino to report the new stage.
- **Analyze now:** `POST /api/ai/classify` (main app, AI Stage page) runs the same cycle, so a manual press also counts toward a transition today.
- **Firmware:** the Arduino keeps the stage in EEPROM and boots into it. Its stage is the "confirmed stage" everywhere (`state["stage"]`, `confirmedStage` in `/api/feeding/config`).
- **Frontend:** `src/lib/stage-requirements.ts` has `referenceDays` 1–10 / 11–24 / 25–42, shown on the AI Stage page as reference only. The Flock page says "Batch dates will appear when real batch records are connected" and has an empty "Batch timeline" card.
- **Project rule today** (AGENTS.md, CLAUDE.md): "Age/day information … is reference-only and must never drive stage selection." This module changes that rule (owner decision 2026-11-06).

## Design

### 1. Schedule logic: a new pure module `raspberry-pi/stage_schedule.py`
It has no hardware imports, so it can be unit-tested on a dev machine.

```python
GROWER_FROM_DAY = 11
FINISHER_FROM_DAY = 25
DAILY_CHECK_TIME = "10:00"        # Asia/Manila; see Q2
DAILY_MAX_CYCLES = 6              # one cycle every 5 min, so a 30-min window at most

def batch_day(start: date | None, today: date) -> int | None: ...

def allowed_targets(day: int | None, current: str) -> tuple[str, ...]:
    """Stages the AI may confirm today. Forward only, gated by day."""
    # day None or < 11 -> ()
    # 11..24 -> ("GROWER",)            if current == "STARTER"
    # >= 25  -> ("GROWER", "FINISHER") if current == "STARTER"   (Q3)
    #           ("FINISHER",)          if current == "GROWER"
    # current == "FINISHER" -> ()      (batch complete)

def schedule_status(day, current, now, last_attempt) -> dict:
    """phase, nextCheckAt, overdueDays, lastAttempt, for the API."""
```

### 2. AI worker in `app.py`
- Automatic cycles run **only inside the daily window**. The window opens at `DAILY_CHECK_TIME` (Manila time) on a day when `allowed_targets()` is not empty and today's attempt isn't finished.
- **In the window,** cycles run every 5 min (as today) until either:
  - 3 consecutive confident cycles agree on an allowed target: confirmed, the stage is sent to the Arduino, and the attempt is done; or
  - `DAILY_MAX_CYCLES` cycles have run: not confirmed, try again tomorrow.
- **Persisted attempt:** the attempt is saved in `stage_schedule.json` next to `app.py`: `{date, cycles, result, detectedStage, confidence, finishedAt}`. A Pi restart in the middle of the day therefore resumes or skips correctly and never runs the window twice.
- **Outside the window** the camera stream keeps working, but no automatic AI cycles run.
- **Failed apply:** if the apply step fails (Arduino offline, maintenance, feeding busy), the attempt stays open. The Pi retries the apply at the next cycle in the window; if the window ends, it tries again the next day.

### 3. Transition rule in `evaluate_stage_transition()`
- A detection counts toward confirmation only if it's in `allowed_targets(day, current)`.
  - A detection of the current stage, an earlier stage, or a stage not allowed yet resets the candidate. Its status is shown (`same_stage`, `not_allowed_yet`, `backward_ignored`).
- With no batch date the result is `no_batch_date`: there is nothing to confirm.
- The 3-cycle confirmation, confidence threshold and safe apply step are unchanged.

### 4. Analyze now (Q1: approved)
**Analyze now still runs a cycle and shows the result, but it never changes the stage.** It's for checking the camera only. Stage changes come only from the daily window.

### 5. Starting a new batch (Q4: approved)
When the owner saves a batch start date **that differs from the saved one** and today is day 1–10, the Pi sends `STAGE:STARTER` (through the same safe apply step) and clears today's attempt. It also logs `[AUDIT] new batch`.
- Saving the same date again (e.g. changing only the bird count) never touches the stage.

### 6. API (no new gateway routes)
`/api/ai/status`, and therefore `/api/snapshot`, gain a `schedule` object:
```json
"schedule": {
  "batchStartDate": "2026-11-01", "batchDay": 8,
  "phase": "no_batch_date" | "stage_unknown" | "starter" | "grower_check" | "grower" | "finisher_check" | "complete",
  "currentStage": "STARTER", "allowedTargets": ["GROWER"],
  "fromDay": {"STARTER": 1, "GROWER": 11, "FINISHER": 25}, "checkTime": "10:00", "maxCyclesPerDay": 6,
  "windowOpen": false, "nextCheckAt": "2026-11-11T10:00:00+08:00",
  "overdueDays": 0, "overdueStage": null,
  "lastAttempt": {"date": "2026-11-10", "cycles": 6, "result": "not_confirmed",
                  "detectedStage": "STARTER", "confidence": 72.4}
}
```
- `phase`: `grower` = in Grower, waiting for day 25; `stage_unknown` = the Arduino hasn't reported a stage.
- `overdueDays` = days past the gate day without a confirmation, counting today only after today's check has failed (day 11 after a failed check → 1, day 12 before its check → 1). `overdueStage` = the stage being waited for.
- The frontend shows these values and never recomputes the day gates. The 11/25 constants live only on the Pi.
- Both `/api/ai/status` and `/api/snapshot` are already gateway routes, so the gateway tables don't change.

### 7. Frontend
- **Flock page, Batch overview:** replace the "Batch dates will appear…" line with **Day N** (or "Set the batch start date below"), the phase, the next check time, and an overdue notice when `overdueDays > 0`. The data comes from the snapshot `schedule` through `useAI`, with no new poll.
- **Batch timeline card:** show Starter, Grower and Finisher with their day gates and the last attempt result. Only real data: it says "—" where there's nothing yet.
- **AI Stage page:**
  - The help text says stage changes happen at the daily check.
  - The Analyze now button says it's a "camera check (doesn't change the stage)".
  - The "Reference days" label becomes "From day 1 / 11 / 25", with the values coming from the API.
- The batch start date input stays in `FeedingPlanner` on the Flock page.

- **Alerts (Q5):** when `overdueDays > 0`, `live-alerts.ts` adds a warning "Grower check overdue" / "Finisher check overdue" with the last result and the action "Check the camera view and lighting; the Pi tries again at the next daily check." Its id includes the date of the last attempt (`stage-overdue-<STAGE>-<date>`), so acknowledging it hides it for that day only, and it comes back after the next failed check.

### 8. Docs
- **AGENTS.md and CLAUDE.md:** replace the "reference-only" rule with "the batch day gates *when* the AI analyses and *which* stage it may confirm (forward only); the AI confirmation still sets the stage; no fallback by day."
- **Obsidian:** AI and stage notes, the decision record (AD-23), CURRENT_STATUS, CHANGELOG, TEST_RESULTS.

### 9. Manual stage confirmation and a clean main app (addendum S5, APPROVED 2026-11-08)
Why: the AI can keep calling Grower birds Starter. With no fallback by day, the stage would then never move. The owner confirms the real stage by hand on the maintenance site.

Owner decisions (2026-11-08):
- (b) **any stage, including backwards**, but only by hand on the maintenance site. Without a manual confirmation the AI stays forward-only and day-gated.
- The main app follows the new stage like any confirmed stage. It **never shows that the maintenance site is or was used**.
- The maintenance site may show simulated/maintenance values (it's the "if anything goes wrong" console).

Design:
- **Pi route `POST /api/bypass/confirm-stage {stage}`** (maintenance token):
  - Any of the 3 stages.
  - Sends `STAGE:<X>` and waits up to 5 s for the Arduino to report it. It works during the maintenance session, and is refused while feed is dispensing or while the Arduino is offline.
  - Resets the AI's 3-in-a-row candidate. From the new stage the daily check continues, forward-only and day-gated (e.g. day 11 + manual Grower → no check until day 25).
  - Recorded in `stage_manual.json` (last 20: time, from, to, client) and as `[AUDIT] manual stage <FROM> -> <TO> by ip:<client>`. Shown only on the maintenance site (`/api/bypass/status` → `manualStageHistory`).
- **What the main app sees** (honest, no fabricated AI data):
  - The confirmed stage and the schedule (day, next check, overdue) come from the real Arduino stage.
  - The AI fields (latest detection, confidence, votes, last check, last AI transition) stay what the camera really did; a manual change writes none of them.
  - Nothing says "manual" or "maintenance".
- **AI detection on the main app (owner choice, option 2):**
  - an AI detection (stage, confidence, votes, "last seen") is shown only when it agrees with the confirmed stage, otherwise "—";
  - values are never altered or invented;
  - the maintenance site always shows the real detection in a "Real AI detection" panel, with a note when it differs.
- **No maintenance traces in the main app's data:** the Pi adds simulation data only for requests with a valid maintenance token:
  - `/api/status` sensor overlays and `maintenanceActive`;
  - `/api/feeding/weight` simulated weights;
  - `/api/ai/status` → `simulation`.

  Without a token, every reading is the real one, and feeding errors during a session say "Hardware busy, try again in a few minutes".
- **`POST /api/ai/classify`** (main app Analyze now) always runs a real camera check. It no longer runs the maintenance simulation.
- **Gateway:**
  - new `MAINTENANCE_ROUTES` entry `bypass/confirm-stage` (POST);
  - the maintenance gateway forwards the token on all its routes (so its snapshot gets the simulation overlay);
  - the main gateway never forwards it (tests prove a client-supplied header is dropped).
- **Console:** the old "Stage test" (simulated analysis, which needed the main app's Analyze now) is replaced by **"Confirm real stage"**:
  - day, current stage, overdue and next check;
  - Starter, Grower and Finisher buttons with a confirm dialog;
  - the last manual changes;
  - "Analyse real stage" (camera check).
- **Main app:** the AI Stage page drops its simulation branches.
- **Tests:**
  - unit tests unchanged;
  - gateway tests for the new route and header rules;
  - offline harness: manual any-direction, refused while dispensing, AI fields untouched, no `simulation` / `maintenanceActive` / overlays without a token.

### 10. Thesis-panel schedule: observe-only pre-checks (addendum, APPROVED 2026-11-09)
Why: the thesis panel rejected checking every 5 minutes and then a fixed 11-day interval. With an 11-day interval the check days are Days 1, 12, 23 and 34, so a flock that becomes Finisher on Day 25 would be detected only on Day 34, nine days late. The approved design checks **daily, but only around the transitions**, and adds a **one-day observe-only pre-check** before each gate. The pre-check warns the farmer early without letting the AI change the stage before the gate.

**Final schedule** (Day 1 = batch start date; every check starts at 10:00 Asia/Manila):

| Batch day / state | What the Pi does | Can the stage change? |
|---|---|---|
| Days 1–9 (Starter) | No scheduled checks | No |
| Day 10 (Starter) | **Grower pre-check:** one daily check, observe only. Readings go to the AI history. If they show Grower with confidence, alert "Flock looks ready for Grower; the stage can change from Day 11" | **No** |
| Day 11 until Grower is confirmed | One daily check; repeated every day, no cap; overdue alert from the first failed day | Yes, to Grower (3 consecutive confident cycles) |
| Grower confirmed until Day 23 | No scheduled checks | No |
| Day 24 (Grower) | **Finisher pre-check:** as Day 10, alert "Flock looks ready for Finisher; the stage can change from Day 25" | **No** |
| Day 25 until Finisher is confirmed | One daily check; repeated daily, no cap; overdue alert | Yes, to Finisher |
| Finisher confirmed | No more scheduled checks for the batch | No |

Unchanged:
- A daily check, **including a pre-check**, runs up to 6 cycles, 5 min apart, and may only *start* between 10:00 and 11:00.
- A change needs 3 consecutive confident cycles that agree.
- Forward only. Analyze now, maintenance analyses and pre-checks **never** change the stage; only the owner's manual "Confirm real stage" can (§9).
- Display rules (§9): the main app shows only AI detections that agree with the confirmed stage. A pre-check reading of the next stage is **not** shown as a detection. The farmer learns about it only through the "looks ready" alert, which names no confidence. Nothing is fabricated or altered.

**Constants.** Every schedule value is a named constant in `raspberry-pi/stage_schedule.py`, and only there, so changing an interval touches one place:

| Constant | Value |
|---|---|
| `GROWER_FROM_DAY` | 11 |
| `FINISHER_FROM_DAY` | 25 |
| `PRE_CHECK_DAYS_BEFORE` | 1 (pre-checks on days 10 and 24) |
| `DAILY_CHECK_TIME` | 10:00 |
| `DAILY_START_LATEST` | 11:00 |
| `DAILY_MAX_CYCLES` | 6 |
| `CYCLE_SPACING_SECONDS` | 300 |
| `CONFIRMATIONS_REQUIRED` | 3 |

`app.py` uses them as `AI_INTERVAL_SECONDS` and `AI_TRANSITION_CONFIRMATIONS_REQUIRED` aliases. They were already moved there on 2026-11-09, with no behavior change and 23/23 tests passing. The frontend shows them from the API.

**Design:**
- **`stage_schedule.py`:**
  - `pre_check_target(day, current)` returns `"GROWER"` for a Starter flock, or `"FINISHER"` for a Grower flock, on the `PRE_CHECK_DAYS_BEFORE` days before that stage's gate (with 1: days 10 and 24). Otherwise it returns `None`. Setting the constant to `0` turns pre-checks off.
  - `window_due()` is also true on a pre-check day, with the same time and attempt rules.
  - `allowed_targets()` is **unchanged**: it is empty on days 10 and 24, so the existing transition rule cannot apply a stage there.
- **Attempt record** (`stage_schedule.json`):
  - A pre-check attempt has `kind: "pre_check"` and `preCheckStage`; a normal attempt has `kind: "check"`.
  - `record_cycle()` counts `readyStreak`: consecutive confident cycles of the pre-check stage.
  - When the streak reaches `CONFIRMATIONS_REQUIRED`, the pre-check ends with `result: "looks_ready"`, the same bar as a real change and no further cycles. Otherwise it ends `not_ready` after 6 cycles. A pre-check never sets `confirmed`.
- **`app.py`:**
  - `run_scheduled_check()` passes the cycle's `confident` flag to `record_cycle()`.
  - In a pre-check, `evaluate_stage_transition()` sees no allowed target, so it reports `not_allowed_yet`, resets the candidate, and calls no apply.
  - Every cycle is already written to the `ai_checks` history table.
- **API** (`schedule` in `/api/ai/status` and `/api/snapshot`; no new routes, gateway unchanged):
  - new phases `grower_pre_check` and `finisher_pre_check`;
  - `preCheckDays: {GROWER: 10, FINISHER: 24}` (`{}` when pre-checks are off), `preCheckStage` (today's pre-check stage or null), and `confirmationsRequired`;
  - `nextCheckAt` now points to the pre-check day (Day 10 / Day 24, 10:00) instead of the gate day;
  - `readyAlert: {stage, date, fromDay} | null`, set while the latest pre-check ended `looks_ready` and the stage hasn't changed since. It carries no confidence.
  - `overdueDays` is unchanged; a pre-check never counts as overdue.
- **Frontend** (shows Pi values, recomputes nothing):
  - `live-alerts.ts` adds an info alert "Flock looks ready for <Stage>" with the text "The stage can change from Day <fromDay>." Its id is `stage-ready-<STAGE>-<date>`.
  - `StageSchedule.tsx` gets phase texts for the two pre-check phases, and its timeline note mentions the pre-check days from `preCheckDays`.
  - The `StageSchedule` type gets the new fields.
  - The dashboard countdown needs no change: it already counts down to `nextCheckAt`.

**Edge cases (proposed):**
- **Still Starter on Day 24** (a late Grower): the normal daily Grower check runs and may confirm Grower. A confident Finisher reading still counts as `not_allowed_yet`. There is no separate Finisher pre-check that day.
- **Still Starter on Day ≥ 25:** unchanged (decision 3); the AI may confirm Grower or Finisher.
- **Grower confirmed late, after Day 24** (e.g. on Day 26): there is no Finisher pre-check, because the Finisher window is already open; checks continue daily from the next day.
- **Grower set by hand before Day 24:** the Day 24 pre-check runs normally.
- **"Start new batch" on Day 10:** the pre-check starts right away, like the normal burst on day ≥ 11. On Day 24 a new batch is Starter, so the normal Grower check starts instead (decision 2). On days 1–9 it stays a camera check only.

## Commands
```
python -m unittest discover -s tests/stage-schedule -v   # pure schedule logic (dev machine)
npm run build && npm run lint                            # frontend
npm run test:gateway                                     # unchanged tables still pass
# Pi deploy: copy app.py + stage_schedule.py to /home/raspberry/poultrix-api (back up first),
# sudo systemctl restart poultrix; curl http://127.0.0.1:5000/api/ai/status
npm run build && npx wrangler deploy                     # main app (needs owner "deploy")
```

## Project structure
- `raspberry-pi/stage_schedule.py`: new pure logic module.
- `raspberry-pi/app.py`: AI worker, `evaluate_stage_transition`, feeding-config save hook, status fields.
- `tests/stage-schedule/test_stage_schedule.py`: new, standard-library `unittest`.
- `src/routes/flock.tsx`, `src/routes/ai-stage.tsx`, `src/lib/live-hardware.ts` (types), `src/lib/stage-requirements.ts` (labels).
- `AGENTS.md`, `CLAUDE.md`, `CAPABILITY_MAP.md`, `tasks/todo-stage-schedule.md`.

## Code style
Follow the existing files. Python uses small functions, uppercase module constants, the `with <lock>:` pattern and `utc_timestamp()`. TypeScript uses the adapters in `src/lib/`, with no Pi calls in pages.

## Testing strategy
- **Unit (dev machine):** `stage_schedule.py`.
  - Day gates at 10/11, 24/25.
  - Forward-only cases.
  - Starter on day 25 (Q3).
  - Finisher → nothing.
  - No date, and a future date.
  - Manila midnight boundary.
  - Window open and closed, max cycles, persisted attempt after a restart.
- **Pi smoke test:** `/api/ai/status` shows `schedule` and the worker log shows "outside window". To test the window, set the batch date so that it's day 11 and temporarily set `DAILY_CHECK_TIME` to a few minutes ahead (test-only, reverted). Watch 3 cycles and the result.
- **Checkpoint S-A (owner, with real birds or test images):**
  - On a day-11 batch, a confirmed Grower switches the Arduino and the LCD.
  - A Starter detection on day 26 while in Grower doesn't move the stage back.
  - Analyze now doesn't change the stage.

## Boundaries
- **Always:**
  - keep the AI confirmation (3 cycles, ≥ 60 %) and the safe apply step;
  - use Manila time for the batch day;
  - back up `app.py` on the Pi before replacing it;
  - update AGENTS.md and CLAUDE.md in the same change as the rule.
- **Ask first:**
  - any firmware change (none planned);
  - changing the 11/25 days, the confirmation count or the confidence threshold;
  - running the window more than once a day.
- **Never:**
  - set Grower or Finisher from the day alone;
  - move the stage backwards automatically;
  - start feeding from this module (that's `auto-feeding`);
  - add gateway routes beyond the one maintenance route in §9;
  - show simulated or maintenance values in the main app (they belong on the maintenance site only);
  - fabricate AI detections, confidence or votes, including for a manual stage change.

## Success criteria
1. With no batch date, no automatic AI cycle runs and the stage never changes. The Flock page asks for the date.
2. On days 1–10 no automatic AI cycle runs and the stage stays Starter.
3. On day ≥ 11 exactly one daily window runs (at most 6 cycles). Three consecutive confident Grower cycles switch the Arduino to GROWER. Otherwise the window ends as `not_confirmed` and runs again the next day.
4. The same holds for Finisher from day 25; if the stage is still Starter on day ≥ 25, a confirmed Grower or Finisher is accepted.
5. No automatic path moves the stage backwards, and Finisher stops all scheduled checks.
6. A Pi restart doesn't repeat or lose the day's attempt.
7. Analyze now never changes the stage.
8. A changed batch start date on days 1–10 sets STARTER.
9. The Flock page shows Day N, phase, next check and overdue notice from real API data, and an overdue stage check also appears in Alerts. Snapshot polling stays at 5 s with no new poll.
10. Unit tests, `npm run build`, `npm run lint` and `npm run test:gateway` pass. AGENTS.md and CLAUDE.md state the new rule.

## Success criteria for §10 (pre-checks)
11. Days 1–9: `window_due` is never true, and `nextCheckAt` is Day 10 at 10:00.
12. Day 10 and Day 24: one pre-check window runs (up to 6 cycles). Even 3+ confident next-stage cycles **never** change the stage. The "looks ready" alert (`readyAlert`) appears only after 3 consecutive confident next-stage cycles; low-confidence or other readings give no alert.
13. Grower can switch only from Day 11, and Finisher only from Day 25.
14. Between Grower confirmed and Day 23 nothing runs, and `nextCheckAt` is Day 24 at 10:00.
15. A late flock is re-checked daily (Days 12, 13, … and 26, 27, …), with the overdue alert.
16. After Finisher is confirmed nothing runs, and `nextCheckAt` is null.
17. Analyze now never changes the stage.
18. Tests: `npm run test:stage-schedule` (new cases for 11–17); `npm run test:auto-feeding`, `npm run build` and `npm run lint` pass (no new TypeScript errors).

## Decisions (owner, 2026-11-08)
8. **(2026-11-09) Thesis-panel schedule (§10):** observe-only pre-checks on Day 10 and Day 24. Decision 1: the "looks ready" alert needs 3 consecutive confident next-stage cycles, and the pre-check then ends. Decision 2: a flock still Starter on Day 24 gets only its Grower check. Decision 3: no Finisher pre-check when Grower is confirmed after Day 24. Decision 4: Start new batch on a pre-check day starts the pre-check. Decision 5: the alert names no confidence.
1. Analyze now is a camera check only; it never changes the stage.
2. Daily check at 10:00 Asia/Manila, up to 6 cycles (30 min), once a day.
3. Still Starter on day ≥ 25: the AI may confirm Grower or Finisher, whichever it sees with confidence.
4. Saving a different batch start date on days 1–10 sets the Arduino to STARTER.
5. An overdue stage check shows on the Flock page **and** in Alerts.
7. **(2026-11-08) The daily burst may only start between 10:00 and 11:00** (`DAILY_START_LATEST`); a window that already started may finish. A batch-date edit in the afternoon no longer starts extra checks; the next check moves to tomorrow 10:00. The schedule reports `nextStage`, `nextStageFromDay`, `daysUntilNextStage`; the dashboard's Confirmed growth stage card shows the batch day, days to the next stage (or overdue), and a live countdown to the next AI check.
6. ~~(2026-11-08) confirmation + 10-min undo on a date change~~ **Replaced the same day (owner) by two explicit actions:**
   - **Start new batch** (`POST /api/feeding/batch/start {batchStartDate, confirm:"NEW_BATCH"}`, owner only):
     - saves the date and clears the old batch's AI check;
     - **always sets STARTER** (decision 1a);
     - **starts an AI check right away**: on day ≥ 11 the normal day-gated burst (may confirm Grower/Finisher); on days 1–10 a camera check only.
   - **Saving the flock setup only corrects the date** (and bird count): it never changes the stage or the checks.
   - This supersedes decision 4 ("a changed date on days 1–10 sets STARTER").

