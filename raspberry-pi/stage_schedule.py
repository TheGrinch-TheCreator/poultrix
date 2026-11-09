"""Day-gated stage schedule (SPEC-stage-schedule.md).

The batch day decides WHEN the AI analyses and WHICH stage it may confirm.
The AI still confirms the stage. Forward only: STARTER -> GROWER -> FINISHER.
The day alone never changes the stage.

Pure logic, no hardware imports, so it is unit-tested on a dev machine
(tests/stage-schedule/). app.py owns the AI worker and the Arduino.
"""
import json
import os
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    TZ = ZoneInfo("Asia/Manila")
except ZoneInfoNotFoundError:  # e.g. Windows without tzdata; Manila is UTC+8, no DST
    TZ = timezone(timedelta(hours=8), "Asia/Manila")
# ---------------------------------------------------------------------------
# Schedule values (thesis-panel design, SPEC-stage-schedule.md). Every tunable
# value of the stage-check schedule lives here and only here; app.py and the
# API read them from this module, the frontend shows them from the API.
# ---------------------------------------------------------------------------
GROWER_FROM_DAY = 11            # first batch day Grower may be confirmed
FINISHER_FROM_DAY = 25          # first batch day Finisher may be confirmed
PRE_CHECK_DAYS_BEFORE = 1       # observe-only pre-check on the N days before a gate
                                # (1 -> days 10 and 24; 0 turns pre-checks off)
DAILY_CHECK_TIME = time(10, 0)  # local (Manila) time the daily window opens
# The daily burst may only START before this (a Pi restart can still catch up);
# later it waits for tomorrow. A batch-date edit in the afternoon must not
# start an extra check (owner, 2026-11-08).
DAILY_START_LATEST = time(11, 0)
DAILY_MAX_CYCLES = 6            # AI cycles per daily window
CYCLE_SPACING_SECONDS = 300     # 5 min between cycles inside a window
CONFIRMATIONS_REQUIRED = 3      # consecutive confident agreeing cycles for a change

STAGES = ("STARTER", "GROWER", "FINISHER")
FROM_DAY = {"STARTER": 1, "GROWER": GROWER_FROM_DAY, "FINISHER": FINISHER_FROM_DAY}
FINISHED = ("confirmed", "not_confirmed", "looks_ready", "not_ready")
# Stage a flock in a given stage moves to next, and that stage's gate day.
NEXT_STAGE = {"STARTER": "GROWER", "GROWER": "FINISHER"}


def local_now():
    return datetime.now(TZ)


def local_date(moment):
    return moment.astimezone(TZ).date()


def _stage(value):
    stage = str(value or "").strip().upper()
    return stage if stage in STAGES else None


def _start_date(start):
    if isinstance(start, date):
        return start
    if not isinstance(start, str) or not start:
        return None
    try:
        return date.fromisoformat(start)
    except ValueError:
        return None


def batch_day(start, today):
    """Day 1 = batch start date. None for no, invalid or future dates."""
    first = _start_date(start)
    if first is None or first > today:
        return None
    return (today - first).days + 1


def allowed_targets(day, current):
    """Stages the AI may confirm on this batch day. Forward only."""
    current = _stage(current)
    if day is None or current is None:
        return ()
    if current == "STARTER":
        if day >= FINISHER_FROM_DAY:
            return ("GROWER", "FINISHER")
        if day >= GROWER_FROM_DAY:
            return ("GROWER",)
    if current == "GROWER" and day >= FINISHER_FROM_DAY:
        return ("FINISHER",)
    return ()


def pre_check_target(day, current):
    """The stage an observe-only pre-check looks for today, or None.

    On the PRE_CHECK_DAYS_BEFORE days before a gate (day 10 for Grower, day 24
    for Finisher) the daily check runs but may NOT change the stage
    (allowed_targets() is still empty then). A flock that is still Starter on
    day 24 gets its normal Grower check instead (owner, 2026-11-09)."""
    current = _stage(current)
    following = NEXT_STAGE.get(current)
    if day is None or following is None or PRE_CHECK_DAYS_BEFORE <= 0:
        return None
    gate = FROM_DAY[following]
    return following if gate - PRE_CHECK_DAYS_BEFORE <= day < gate else None


def _first_check_day(stage):
    """First batch day with a scheduled check for a flock waiting for `stage`."""
    return FROM_DAY[stage] - max(0, PRE_CHECK_DAYS_BEFORE)


def _finished_on(attempt, today):
    return bool(attempt) and attempt.get("date") == today.isoformat() and attempt.get("result") in FINISHED


def _started_on(attempt, today):
    return bool(attempt) and attempt.get("date") == today.isoformat() and attempt.get("result") == "running"


def window_due(now, start, current, attempt):
    """True when an automatic AI cycle should run now."""
    today = local_date(now)
    day = batch_day(start, today)
    if not allowed_targets(day, current) and not pre_check_target(day, current):
        return False
    local_time = now.astimezone(TZ).time()
    if local_time < DAILY_CHECK_TIME or _finished_on(attempt, today):
        return False
    if _started_on(attempt, today):
        return True  # a window that already started may finish its cycles
    return local_time < DAILY_START_LATEST


def record_cycle(attempt, now, detected, confidence, applied, confident=False, pre_check=None):
    """Record one scheduled AI cycle. `applied` = the stage change reached the
    Arduino. `pre_check` = the stage an observe-only pre-check looks for
    (pre_check_target()); a pre-check never ends "confirmed". Returns the new
    attempt (a fresh one on a new day)."""
    today = local_date(now).isoformat()
    if not attempt or attempt.get("date") != today:
        attempt = {"date": today, "cycles": 0, "result": "running", "target": None,
                   "detectedStage": None, "confidence": None, "finishedAt": None}
    attempt = dict(attempt)
    if not attempt.get("startedAt"):
        attempt["startedAt"] = now.isoformat()  # when this daily check began
    pre_check = _stage(pre_check)
    attempt["kind"] = "pre_check" if pre_check else "check"
    attempt["cycles"] += 1
    attempt["detectedStage"] = _stage(detected)
    attempt["confidence"] = round(float(confidence), 2) if confidence is not None else None
    if pre_check:
        # Observe only: count consecutive confident readings of the next stage,
        # with the same bar as a real change (CONFIRMATIONS_REQUIRED).
        attempt["preCheckStage"] = pre_check
        seen = bool(confident) and attempt["detectedStage"] == pre_check
        attempt["readyStreak"] = attempt.get("readyStreak", 0) + 1 if seen else 0
        if attempt["readyStreak"] >= CONFIRMATIONS_REQUIRED:
            attempt.update(result="looks_ready", finishedAt=now.isoformat())
        elif attempt["cycles"] >= DAILY_MAX_CYCLES:
            attempt.update(result="not_ready", finishedAt=now.isoformat())
        return attempt
    if applied:
        attempt.update(result="confirmed", target=_stage(detected), finishedAt=now.isoformat())
    elif attempt["cycles"] >= DAILY_MAX_CYCLES:
        attempt.update(result="not_confirmed", finishedAt=now.isoformat())
    return attempt


def load_attempt(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("date"), str) or not isinstance(data.get("cycles"), int):
        return None
    try:
        date.fromisoformat(data["date"])
    except ValueError:
        return None
    return data


def save_attempt(path, attempt):
    """Atomic write; None removes the file (e.g. a new batch)."""
    path = Path(path)
    if attempt is None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(attempt, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _phase(day, current):
    if day is None:
        return "no_batch_date"
    if current is None:
        return "stage_unknown"
    if current == "FINISHER":
        return "complete"
    pre = pre_check_target(day, current)
    if current == "STARTER":
        return "grower_check" if day >= GROWER_FROM_DAY else "grower_pre_check" if pre else "starter"
    return "finisher_check" if day >= FINISHER_FROM_DAY else "finisher_pre_check" if pre else "grower"


def schedule_status(start, current, now, attempt):
    """The `schedule` object reported by /api/ai/status."""
    current = _stage(current)
    today = local_date(now)
    first = _start_date(start)
    day = batch_day(start, today)
    phase = _phase(day, current)
    targets = allowed_targets(day, current)
    pre = pre_check_target(day, current)

    overdue_stage = None
    overdue_days = 0
    next_check = None
    if phase in ("starter", "grower_pre_check", "grower_check", "grower", "finisher_pre_check", "finisher_check"):
        gate = GROWER_FROM_DAY if current == "STARTER" else FINISHER_FROM_DAY
        waiting_for = NEXT_STAGE[current]
        if day >= gate:
            overdue_days = (day - gate) + (1 if _finished_on(attempt, today) else 0)
            if overdue_days > 0:
                overdue_stage = "GROWER" if current == "STARTER" else "FINISHER"
        # The first scheduled check is the pre-check day (day 10 / day 24).
        gate_date = first + timedelta(days=_first_check_day(waiting_for) - 1)
        too_late = now.astimezone(TZ).time() >= DAILY_START_LATEST and not _started_on(attempt, today)
        earliest = today + timedelta(days=1) if (_finished_on(attempt, today) or too_late) else today
        check_date = max(earliest, gate_date)
        next_check = datetime.combine(check_date, DAILY_CHECK_TIME, tzinfo=TZ).isoformat()

    next_stage = {"STARTER": "GROWER", "GROWER": "FINISHER"}.get(current)
    next_from = FROM_DAY[next_stage] if next_stage else None
    days_until = max(0, next_from - day) if next_stage and day is not None else None

    # "Flock looks ready" (owner, 2026-11-09): the latest pre-check saw the
    # next stage CONFIRMATIONS_REQUIRED times in a row, and the stage hasn't
    # changed since. Carries no confidence: the main app never shows a
    # reading of a stage other than the confirmed one.
    ready_alert = None
    if (attempt and attempt.get("kind") == "pre_check" and attempt.get("result") == "looks_ready"
            and attempt.get("preCheckStage") == next_stage):
        ready_alert = {"stage": next_stage, "date": attempt.get("date"), "fromDay": next_from}

    window_open = (
        bool(targets or pre) and bool(attempt) and attempt.get("date") == today.isoformat()
        and attempt.get("result") == "running"
    )
    return {
        "batchStartDate": first.isoformat() if first else None,
        "batchDay": day,
        "phase": phase,
        "currentStage": current,
        "allowedTargets": list(targets),
        "fromDay": dict(FROM_DAY),
        "preCheckDays": ({s: FROM_DAY[s] - PRE_CHECK_DAYS_BEFORE for s in ("GROWER", "FINISHER")}
                         if PRE_CHECK_DAYS_BEFORE > 0 else {}),
        "preCheckStage": pre,
        "checkTime": DAILY_CHECK_TIME.strftime("%H:%M"),
        "maxCyclesPerDay": DAILY_MAX_CYCLES,
        "confirmationsRequired": CONFIRMATIONS_REQUIRED,
        "windowOpen": window_open,
        "nextCheckAt": next_check,
        "nextStage": next_stage,
        "nextStageFromDay": next_from,
        "daysUntilNextStage": days_until,
        "overdueDays": overdue_days,
        "overdueStage": overdue_stage,
        "readyAlert": ready_alert,
        "lastAttempt": dict(attempt) if attempt else None,
    }
