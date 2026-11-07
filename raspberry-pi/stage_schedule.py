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
GROWER_FROM_DAY = 11
FINISHER_FROM_DAY = 25
DAILY_CHECK_TIME = time(10, 0)  # local (Manila) time the daily window opens
DAILY_MAX_CYCLES = 6            # AI cycles per daily window (one every 5 min)

STAGES = ("STARTER", "GROWER", "FINISHER")
FROM_DAY = {"STARTER": 1, "GROWER": GROWER_FROM_DAY, "FINISHER": FINISHER_FROM_DAY}
FINISHED = ("confirmed", "not_confirmed")


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


def _finished_on(attempt, today):
    return bool(attempt) and attempt.get("date") == today.isoformat() and attempt.get("result") in FINISHED


def window_due(now, start, current, attempt):
    """True when an automatic AI cycle should run now."""
    today = local_date(now)
    if not allowed_targets(batch_day(start, today), current):
        return False
    if now.astimezone(TZ).time() < DAILY_CHECK_TIME:
        return False
    return not _finished_on(attempt, today)


def record_cycle(attempt, now, detected, confidence, applied):
    """Record one scheduled AI cycle. `applied` = the stage change reached the
    Arduino. Returns the new attempt (a fresh one on a new day)."""
    today = local_date(now).isoformat()
    if not attempt or attempt.get("date") != today:
        attempt = {"date": today, "cycles": 0, "result": "running", "target": None,
                   "detectedStage": None, "confidence": None, "finishedAt": None}
    attempt = dict(attempt)
    attempt["cycles"] += 1
    attempt["detectedStage"] = _stage(detected)
    attempt["confidence"] = round(float(confidence), 2) if confidence is not None else None
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
    if current == "STARTER":
        return "grower_check" if day >= GROWER_FROM_DAY else "starter"
    return "finisher_check" if day >= FINISHER_FROM_DAY else "grower"


def schedule_status(start, current, now, attempt):
    """The `schedule` object reported by /api/ai/status."""
    current = _stage(current)
    today = local_date(now)
    first = _start_date(start)
    day = batch_day(start, today)
    phase = _phase(day, current)
    targets = allowed_targets(day, current)

    overdue_stage = None
    overdue_days = 0
    next_check = None
    if phase in ("starter", "grower_check", "grower", "finisher_check"):
        gate = GROWER_FROM_DAY if current == "STARTER" else FINISHER_FROM_DAY
        if day >= gate:
            overdue_days = (day - gate) + (1 if _finished_on(attempt, today) else 0)
            if overdue_days > 0:
                overdue_stage = "GROWER" if current == "STARTER" else "FINISHER"
        gate_date = first + timedelta(days=gate - 1)
        earliest = today + timedelta(days=1) if _finished_on(attempt, today) else today
        check_date = max(earliest, gate_date)
        next_check = datetime.combine(check_date, DAILY_CHECK_TIME, tzinfo=TZ).isoformat()

    window_open = (
        bool(targets) and bool(attempt) and attempt.get("date") == today.isoformat()
        and attempt.get("result") == "running"
    )
    return {
        "batchStartDate": first.isoformat() if first else None,
        "batchDay": day,
        "phase": phase,
        "currentStage": current,
        "allowedTargets": list(targets),
        "fromDay": dict(FROM_DAY),
        "checkTime": DAILY_CHECK_TIME.strftime("%H:%M"),
        "maxCyclesPerDay": DAILY_MAX_CYCLES,
        "windowOpen": window_open,
        "nextCheckAt": next_check,
        "overdueDays": overdue_days,
        "overdueStage": overdue_stage,
        "lastAttempt": dict(attempt) if attempt else None,
    }
