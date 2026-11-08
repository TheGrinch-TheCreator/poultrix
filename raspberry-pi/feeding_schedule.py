"""Automatic feeding decisions (SPEC-auto-feeding.md).

Pure logic, no hardware imports, unit-tested on a dev machine
(tests/auto-feeding/). app.py owns the scheduler thread, the trough
readings, the gates and the Arduino.

Rules (owner decisions 2026-11-08):
- dispense = session target - trough weight, never below 0;
- skip if the trough is at/above target, or less than MIN_DISPENSE_GRAMS is needed;
- at most MAX_DISPENSE_SECONDS of gate time per session (dispense the cap, flag partial);
- an invalid trough reading means skip (never guess);
- a session runs up to LATE_WINDOW minutes after its time, otherwise it is missed;
- FAULT_LIMIT consecutive faults turn automation off.
"""
import json
import math
import os
import statistics
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    TZ = ZoneInfo("Asia/Manila")
except ZoneInfoNotFoundError:  # e.g. Windows without tzdata; Manila is UTC+8, no DST
    TZ = timezone(timedelta(hours=8), "Asia/Manila")

TROUGH_WINDOW_SECONDS = 10.0
TROUGH_MIN_SAMPLES = 5
TROUGH_MAX_AGE_SECONDS = 5.0
TROUGH_MAX_SPREAD_GRAMS = 25.0
TROUGH_NEGATIVE_LIMIT_GRAMS = -25.0
MIN_DISPENSE_GRAMS = 20.0
MAX_DISPENSE_SECONDS = 10.0
LATE_WINDOW = timedelta(minutes=15)
FAULT_LIMIT = 3
KEEP_DAYS = 7
RESULTS = ("dispensed", "partial", "skipped", "missed", "fault")


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def trough_valid(samples, now, commissioned=True):
    """samples: [(monotonic_time, grams)]. Valid only if >= 5 numeric samples
    in the last 10 s, the newest < 5 s old, spread <= 25 g and median >= -25 g.
    Returns {valid, grams, reason}."""
    if not commissioned:
        return {"valid": False, "grams": None, "reason": "not_commissioned"}
    recent = [(t, g) for t, g in samples or [] if _number(t) and _number(g) and t >= now - TROUGH_WINDOW_SECONDS]
    if len(recent) < TROUGH_MIN_SAMPLES:
        return {"valid": False, "grams": None, "reason": "too_few_samples"}
    if now - max(t for t, _ in recent) >= TROUGH_MAX_AGE_SECONDS:
        return {"valid": False, "grams": None, "reason": "stale"}
    values = [g for _, g in recent]
    if max(values) - min(values) > TROUGH_MAX_SPREAD_GRAMS:
        return {"valid": False, "grams": None, "reason": "unstable"}
    median = statistics.median(values)
    if median < TROUGH_NEGATIVE_LIMIT_GRAMS:
        return {"valid": False, "grams": None, "reason": "negative"}
    return {"valid": True, "grams": round(max(0.0, median), 1), "reason": None}


def session_need(target, trough, rate):
    """How much to dispense for one session. Returns
    {action: dispense|skip, grams, seconds, partial, reason}."""
    def skip(reason):
        return {"action": "skip", "grams": 0, "seconds": 0, "partial": False, "reason": reason}
    if not _number(target) or target <= 0:
        return skip("no_target")
    if not _number(rate) or rate <= 0:
        return skip("bad_rate")
    if not _number(trough):
        return skip("no_trough")
    need = target - max(0.0, trough)
    if need <= 0:
        return skip("trough_at_target")
    if need < MIN_DISPENSE_GRAMS:
        return skip("too_small")
    seconds = need / rate
    partial = seconds > MAX_DISPENSE_SECONDS
    if partial:
        seconds = MAX_DISPENSE_SECONDS
        need = seconds * rate
    return {"action": "dispense", "grams": round(need, 1), "seconds": round(seconds, 3),
            "partial": partial, "reason": "cap_reached" if partial else None}


def _slots(times):
    out = []
    for value in times or []:
        try:
            hh, mm = str(value).split(":")
            out.append((str(value), time(int(hh), int(mm))))
        except (ValueError, TypeError):
            continue
    return sorted(out, key=lambda item: item[1])


def due_session(now, times, done):
    """Which session runs now. `done` = times already recorded today.
    Returns {due, missed, next}: due within LATE_WINDOW after its time;
    missed = earlier undone times past the window; next = the next future slot."""
    local = now.astimezone(TZ)
    today = local.date()
    due, missed = None, []
    upcoming = None
    for label, slot in _slots(times):
        start = datetime.combine(today, slot, tzinfo=TZ)
        if start > local:
            if upcoming is None:
                upcoming = start
            continue
        if label in done:
            continue
        if local < start + LATE_WINDOW:
            due = due or label
        else:
            missed.append(label)
    if upcoming is None and _slots(times):
        upcoming = datetime.combine(today + timedelta(days=1), _slots(times)[0][1], tzinfo=TZ)
    return {"due": due, "missed": missed, "next": upcoming.isoformat() if upcoming else None}


def make_record(now, slot, stage, target, trough, dispensed, result, reason, **extra):
    local = now.astimezone(TZ)
    record = {"date": local.date().isoformat(), "time": slot, "stage": stage,
              "targetGrams": target, "troughGrams": trough, "dispensedGrams": dispensed,
              "result": result, "reason": reason, "at": local.isoformat()}
    record.update(extra)
    return record


def add_record(sessions, record, today):
    """Append and keep only the last KEEP_DAYS days."""
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    return [s for s in list(sessions) + [record] if s.get("date", "") > cutoff]


def done_times(sessions, day):
    key = day.isoformat()
    return {s["time"] for s in sessions if s.get("date") == key}


def _valid_record(item):
    if not isinstance(item, dict) or not isinstance(item.get("time"), str) or item.get("result") not in RESULTS:
        return False
    try:
        date.fromisoformat(item.get("date"))
    except (TypeError, ValueError):
        return False
    return True


def load_sessions(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [item for item in data if _valid_record(item)] if isinstance(data, list) else []


def save_sessions(path, sessions):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(sessions, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def fault_streak(sessions):
    """Consecutive faults from the newest record. Skips and misses neither
    count nor break the streak; a successful dispense resets it."""
    streak = 0
    for record in reversed(sessions):
        result = record.get("result")
        if result == "fault":
            streak += 1
        elif result in ("dispensed", "partial"):
            break
    return streak


def should_disable(sessions):
    return fault_streak(sessions) >= FAULT_LIMIT
