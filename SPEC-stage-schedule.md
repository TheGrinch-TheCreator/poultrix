# Spec: stage-schedule

Status: **APPROVED 2026-11-08** (owner: Q1 yes, Q2 yes, Q3 yes, Q4 yes, Q5 → also in Alerts). Plan and tasks: `tasks/todo-stage-schedule.md`. Module `stage-schedule` in `CAPABILITY_MAP.md` (no dependencies; `auto-feeding` depends on it).

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
  "phase": "starter" | "grower_check" | "finisher_check" | "complete" | "no_batch_date",
  "allowedTargets": ["GROWER"],
  "nextCheckAt": "2026-11-11T10:00:00+08:00",
  "overdueDays": 0,
  "lastAttempt": {"date": "2026-11-10", "cycles": 6, "result": "not_confirmed",
                  "detectedStage": "STARTER", "confidence": 72.4}
}
```
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
  - add gateway routes for this;
  - show simulated or maintenance stages as real.

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

## Decisions (owner, 2026-11-08)
1. Analyze now is a camera check only; it never changes the stage.
2. Daily check at 10:00 Asia/Manila, up to 6 cycles (30 min), once a day.
3. Still Starter on day ≥ 25: the AI may confirm Grower or Finisher, whichever it sees with confidence.
4. Saving a different batch start date on days 1–10 sets the Arduino to STARTER.
5. An overdue stage check shows on the Flock page **and** in Alerts.
