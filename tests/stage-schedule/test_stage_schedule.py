"""Unit tests for raspberry-pi/stage_schedule.py (SPEC-stage-schedule.md).

Run: python -m unittest discover -s tests/stage-schedule -v
"""
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "raspberry-pi"))

import stage_schedule as ss  # noqa: E402

TZ = ss.TZ
START = date(2026, 11, 1)  # day 1


def at(d, hh=12, mm=0):
    return datetime(d.year, d.month, d.day, hh, mm, tzinfo=TZ)


def day_n(n):
    return START + timedelta(days=n - 1)


class BatchDay(unittest.TestCase):
    def test_day_one_is_start_date(self):
        self.assertEqual(ss.batch_day("2026-11-01", START), 1)
        self.assertEqual(ss.batch_day(START, day_n(11)), 11)

    def test_missing_invalid_or_future(self):
        self.assertIsNone(ss.batch_day(None, START))
        self.assertIsNone(ss.batch_day("", START))
        self.assertIsNone(ss.batch_day("not-a-date", START))
        self.assertIsNone(ss.batch_day(123, START))
        self.assertIsNone(ss.batch_day("2026-11-02", START))

    def test_manila_midnight(self):
        # 2026-11-10 23:30 UTC is 2026-11-11 07:30 in Manila (UTC+8).
        from datetime import timezone
        utc = datetime(2026, 11, 10, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(ss.local_date(utc), date(2026, 11, 11))
        self.assertEqual(ss.batch_day(START, ss.local_date(utc)), 11)


class AllowedTargets(unittest.TestCase):
    def test_starter_gates(self):
        self.assertEqual(ss.allowed_targets(None, "STARTER"), ())
        self.assertEqual(ss.allowed_targets(10, "STARTER"), ())
        self.assertEqual(ss.allowed_targets(11, "STARTER"), ("GROWER",))
        self.assertEqual(ss.allowed_targets(24, "STARTER"), ("GROWER",))
        # Owner decision 3: still Starter on day >= 25 -> Grower or Finisher.
        self.assertEqual(ss.allowed_targets(25, "STARTER"), ("GROWER", "FINISHER"))
        self.assertEqual(ss.allowed_targets(26, "STARTER"), ("GROWER", "FINISHER"))

    def test_grower_gates(self):
        self.assertEqual(ss.allowed_targets(11, "GROWER"), ())
        self.assertEqual(ss.allowed_targets(24, "GROWER"), ())
        self.assertEqual(ss.allowed_targets(25, "GROWER"), ("FINISHER",))

    def test_forward_only_and_unknown(self):
        self.assertEqual(ss.allowed_targets(40, "FINISHER"), ())
        self.assertNotIn("STARTER", ss.allowed_targets(40, "GROWER"))
        self.assertEqual(ss.allowed_targets(30, ""), ())
        self.assertEqual(ss.allowed_targets(30, None), ())
        self.assertEqual(ss.allowed_targets(30, "grower"), ("FINISHER",))


class Window(unittest.TestCase):
    def test_not_before_check_time(self):
        self.assertFalse(ss.window_due(at(day_n(11), 9, 59), START, "STARTER", None))
        self.assertTrue(ss.window_due(at(day_n(11), 10, 0), START, "STARTER", None))
        # A window that hasn't started by 11:00 waits for tomorrow (owner, 2026-11-08).
        self.assertFalse(ss.window_due(at(day_n(11), 23, 0), START, "STARTER", None))

    def test_not_on_days_without_targets(self):
        self.assertFalse(ss.window_due(at(day_n(9), 10, 30), START, "STARTER", None))
        self.assertFalse(ss.window_due(at(day_n(20), 11), START, "GROWER", None))
        self.assertFalse(ss.window_due(at(day_n(40), 11), START, "FINISHER", None))
        self.assertFalse(ss.window_due(at(day_n(20), 11), None, "STARTER", None))

    def test_six_cycles_then_done_for_the_day(self):
        today = day_n(11)
        attempt = None
        for i in range(ss.DAILY_MAX_CYCLES):
            self.assertTrue(ss.window_due(at(today, 10, 5 * i), START, "STARTER", attempt))
            attempt = ss.record_cycle(attempt, at(today, 10, 5 * i), "STARTER", 72.4, applied=False)
        self.assertEqual(attempt["cycles"], 6)
        self.assertEqual(attempt["result"], "not_confirmed")
        self.assertEqual(attempt["detectedStage"], "STARTER")
        self.assertEqual(attempt["confidence"], 72.4)
        self.assertIsNotNone(attempt["finishedAt"])
        self.assertFalse(ss.window_due(at(today, 15), START, "STARTER", attempt))
        # Next day: a new window.
        self.assertTrue(ss.window_due(at(day_n(12), 10), START, "STARTER", attempt))
        fresh = ss.record_cycle(attempt, at(day_n(12), 10), "GROWER", 80.0, applied=False)
        self.assertEqual((fresh["date"], fresh["cycles"], fresh["result"]), (day_n(12).isoformat(), 1, "running"))

    def test_confirmed_is_not_rerun(self):
        today = day_n(11)
        attempt = ss.record_cycle(None, at(today, 10), "GROWER", 90.0, applied=False)
        attempt = ss.record_cycle(attempt, at(today, 10, 5), "GROWER", 90.0, applied=False)
        self.assertEqual(attempt["result"], "running")
        attempt = ss.record_cycle(attempt, at(today, 10, 10), "GROWER", 90.0, applied=True)
        self.assertEqual(attempt["result"], "confirmed")
        self.assertEqual(attempt["target"], "GROWER")
        self.assertFalse(ss.window_due(at(today, 12), START, "STARTER", attempt))

    def test_failed_cycle_counts(self):
        attempt = ss.record_cycle(None, at(day_n(11), 10), None, None, applied=False)
        self.assertEqual(attempt["cycles"], 1)
        self.assertIsNone(attempt["detectedStage"])


class WindowStartLimit(unittest.TestCase):
    """The daily burst may only START between 10:00 and 11:00 (owner, 2026-11-08):
    a batch-date change in the afternoon must not start an extra check."""

    def test_no_start_after_11(self):
        self.assertTrue(ss.window_due(at(day_n(26), 10, 59), START, "GROWER", None))
        self.assertFalse(ss.window_due(at(day_n(26), 11, 0), START, "GROWER", None))
        self.assertFalse(ss.window_due(at(day_n(26), 15, 36), START, "GROWER", None))

    def test_started_window_may_finish_after_11(self):
        attempt = ss.record_cycle(None, at(day_n(26), 10, 50), "GROWER", 80.0, applied=False)
        self.assertTrue(ss.window_due(at(day_n(26), 11, 20), START, "GROWER", attempt))

    def test_next_check_moves_to_tomorrow_after_11(self):
        s = ss.schedule_status(START, "GROWER", at(day_n(26), 15, 0), None)
        self.assertEqual(s["nextCheckAt"], at(day_n(27), 10).isoformat())
        s = ss.schedule_status(START, "GROWER", at(day_n(26), 9, 0), None)
        self.assertEqual(s["nextCheckAt"], at(day_n(26), 10).isoformat())


class NextStage(unittest.TestCase):
    def test_days_until_next_stage(self):
        s = ss.schedule_status(START, "STARTER", at(day_n(5)), None)
        self.assertEqual((s["nextStage"], s["nextStageFromDay"], s["daysUntilNextStage"]), ("GROWER", 11, 6))
        s = ss.schedule_status(START, "GROWER", at(day_n(15)), None)
        self.assertEqual((s["nextStage"], s["nextStageFromDay"], s["daysUntilNextStage"]), ("FINISHER", 25, 10))
        s = ss.schedule_status(START, "GROWER", at(day_n(29)), None)
        self.assertEqual((s["nextStage"], s["daysUntilNextStage"]), ("FINISHER", 0))
        s = ss.schedule_status(START, "FINISHER", at(day_n(30)), None)
        self.assertEqual((s["nextStage"], s["daysUntilNextStage"]), (None, None))
        s = ss.schedule_status(None, "STARTER", at(day_n(5)), None)
        self.assertEqual(s["daysUntilNextStage"], None)


class Persistence(unittest.TestCase):
    def test_round_trip_and_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "stage_schedule.json"
            self.assertIsNone(ss.load_attempt(path))
            attempt = ss.record_cycle(None, at(day_n(11), 10), "STARTER", 70.0, applied=False)
            ss.save_attempt(path, attempt)
            self.assertEqual(ss.load_attempt(path), attempt)
            path.write_text("{broken")
            self.assertIsNone(ss.load_attempt(path))
            path.write_text(json.dumps({"date": "x", "cycles": "many"}))
            self.assertIsNone(ss.load_attempt(path))
            ss.save_attempt(path, None)
            self.assertIsNone(ss.load_attempt(path))
            self.assertFalse(path.exists())


class Status(unittest.TestCase):
    def test_no_batch_date(self):
        s = ss.schedule_status(None, "STARTER", at(START), None)
        self.assertEqual(s["phase"], "no_batch_date")
        self.assertIsNone(s["batchDay"])
        self.assertIsNone(s["nextCheckAt"])
        self.assertEqual(s["overdueDays"], 0)

    def test_starter_period(self):
        s = ss.schedule_status("2026-11-01", "STARTER", at(day_n(5)), None)
        self.assertEqual((s["phase"], s["batchDay"], s["allowedTargets"]), ("starter", 5, []))
        # Spec §10: the first scheduled check is the Day 10 pre-check.
        self.assertEqual(s["nextCheckAt"], at(day_n(10), 10).isoformat())
        self.assertEqual(s["fromDay"], {"STARTER": 1, "GROWER": 11, "FINISHER": 25})

    def test_grower_check_and_overdue(self):
        # Day 11 before the first check: not overdue, check today 10:00.
        s = ss.schedule_status(START, "STARTER", at(day_n(11), 8), None)
        self.assertEqual((s["phase"], s["overdueDays"], s["overdueStage"]), ("grower_check", 0, None))
        self.assertEqual(s["nextCheckAt"], at(day_n(11), 10).isoformat())
        self.assertFalse(s["windowOpen"])
        # Window running.
        running = ss.record_cycle(None, at(day_n(11), 10), "STARTER", 70.0, applied=False)
        s = ss.schedule_status(START, "STARTER", at(day_n(11), 10, 1), running)
        self.assertTrue(s["windowOpen"])
        # Day 11 after a failed check: 1 day overdue, next check tomorrow.
        failed = running
        for i in range(1, ss.DAILY_MAX_CYCLES):
            failed = ss.record_cycle(failed, at(day_n(11), 10, 5 * i), "STARTER", 70.0, applied=False)
        s = ss.schedule_status(START, "STARTER", at(day_n(11), 11), failed)
        self.assertEqual((s["overdueDays"], s["overdueStage"]), (1, "GROWER"))
        self.assertEqual(s["nextCheckAt"], at(day_n(12), 10).isoformat())
        self.assertEqual(s["lastAttempt"]["result"], "not_confirmed")
        # Day 12 before its check: still 1 day overdue.
        s = ss.schedule_status(START, "STARTER", at(day_n(12), 8), failed)
        self.assertEqual(s["overdueDays"], 1)

    def test_grower_waits_for_day_25(self):
        s = ss.schedule_status(START, "GROWER", at(day_n(15)), None)
        self.assertEqual((s["phase"], s["allowedTargets"], s["overdueDays"]), ("grower", [], 0))
        # Spec §10: the next scheduled check is the Day 24 Finisher pre-check.
        self.assertEqual(s["nextCheckAt"], at(day_n(24), 10).isoformat())
        s = ss.schedule_status(START, "GROWER", at(day_n(27), 11), None)
        self.assertEqual((s["phase"], s["overdueDays"], s["overdueStage"]), ("finisher_check", 2, "FINISHER"))

    def test_still_starter_late(self):
        s = ss.schedule_status(START, "STARTER", at(day_n(26), 8), None)
        self.assertEqual(s["phase"], "grower_check")
        self.assertEqual(s["allowedTargets"], ["GROWER", "FINISHER"])
        self.assertEqual((s["overdueDays"], s["overdueStage"]), (15, "GROWER"))

    def test_complete_and_unknown(self):
        s = ss.schedule_status(START, "FINISHER", at(day_n(30)), None)
        self.assertEqual((s["phase"], s["nextCheckAt"], s["overdueDays"]), ("complete", None, 0))
        s = ss.schedule_status(START, None, at(day_n(12)), None)
        self.assertEqual((s["phase"], s["nextCheckAt"]), ("stage_unknown", None))

    def test_old_attempt_not_reported_as_today(self):
        old = ss.record_cycle(None, at(day_n(11), 10), "STARTER", 70.0, applied=False)
        s = ss.schedule_status(START, "STARTER", at(day_n(13), 8), old)
        self.assertEqual(s["lastAttempt"]["date"], day_n(11).isoformat())
        # A window that was still "running" on an earlier day (Pi restart) does not count as open today.
        self.assertFalse(s["windowOpen"])


# ---------------------------------------------------------------------------
# Spec §10 (thesis-panel schedule, approved 2026-11-09): daily checks only
# around the transitions, with a one-day observe-only pre-check before each gate.
# ---------------------------------------------------------------------------
def run_window(day, current, readings, pre_check=None, applied_on=None):
    """Run one daily window (10:00, every 5 min) with (stage, confidence, confident)
    readings until it finishes. Returns (attempt, cycles_run)."""
    attempt, ran = None, 0
    for i, (stage, conf, confident) in enumerate(readings):
        moment = at(day_n(day), 10, 5 * i)
        if not ss.window_due(moment, START, current, attempt):
            break
        attempt = ss.record_cycle(attempt, moment, stage, conf, applied=(applied_on == i),
                                  confident=confident, pre_check=pre_check)
        ran += 1
    return attempt, ran


CONFIDENT_GROWER = [("GROWER", 90.0, True)] * 10


class NoChecksDays1To9(unittest.TestCase):
    def test_days_1_to_9_never_due(self):
        for day in range(1, 10):
            for hh, mm in ((10, 0), (10, 30), (10, 59)):
                self.assertFalse(ss.window_due(at(day_n(day), hh, mm), START, "STARTER", None), day)
            self.assertIsNone(ss.pre_check_target(day, "STARTER"))
            self.assertEqual(ss.allowed_targets(day, "STARTER"), ())


class PreCheck(unittest.TestCase):
    def test_pre_check_days(self):
        self.assertEqual(ss.pre_check_target(10, "STARTER"), "GROWER")
        self.assertEqual(ss.pre_check_target(24, "GROWER"), "FINISHER")
        for day, stage in ((9, "STARTER"), (11, "STARTER"), (23, "GROWER"), (25, "GROWER"),
                           (24, "STARTER"), (24, "FINISHER"), (10, "GROWER"), (10, None)):
            self.assertIsNone(ss.pre_check_target(day, stage), (day, stage))
        # The stage can't be changed on a pre-check day.
        self.assertEqual(ss.allowed_targets(10, "STARTER"), ())
        self.assertEqual(ss.allowed_targets(24, "GROWER"), ())

    def test_day_10_runs_a_window(self):
        self.assertFalse(ss.window_due(at(day_n(10), 9, 59), START, "STARTER", None))
        self.assertTrue(ss.window_due(at(day_n(10), 10), START, "STARTER", None))
        self.assertFalse(ss.window_due(at(day_n(10), 11), START, "STARTER", None))
        s = ss.schedule_status(START, "STARTER", at(day_n(10), 8), None)
        self.assertEqual((s["phase"], s["preCheckStage"], s["allowedTargets"]), ("grower_pre_check", "GROWER", []))
        self.assertEqual(s["nextCheckAt"], at(day_n(10), 10).isoformat())
        self.assertEqual(s["preCheckDays"], {"GROWER": 10, "FINISHER": 24})

    def _assert_observe_only(self, day, current, target):
        readings = [(target, 95.0, True)] * 10
        # Even if the caller wrongly reported an apply, a pre-check never ends "confirmed".
        attempt, ran = run_window(day, current, readings, pre_check=target, applied_on=0)
        self.assertEqual(attempt["kind"], "pre_check")
        self.assertEqual(attempt["result"], "looks_ready")
        self.assertEqual(ran, ss.CONFIRMATIONS_REQUIRED)  # ends early, like a confirmation
        self.assertIsNone(attempt["target"])
        self.assertNotEqual(attempt["result"], "confirmed")
        s = ss.schedule_status(START, current, at(day_n(day), 11), attempt)
        self.assertEqual(s["currentStage"], current)  # the stage did not move
        self.assertEqual(s["readyAlert"], {"stage": target, "date": day_n(day).isoformat(),
                                           "fromDay": ss.FROM_DAY[target]})
        self.assertNotIn("confidence", s["readyAlert"])  # no next-stage reading on the main app
        self.assertEqual(s["overdueDays"], 0)
        # Done for the day; the next check is the gate day at 10:00.
        self.assertFalse(ss.window_due(at(day_n(day), 10, 30), START, current, attempt))
        self.assertEqual(s["nextCheckAt"], at(day_n(day + 1), 10).isoformat())

    def test_day_10_never_changes_stage(self):
        self._assert_observe_only(10, "STARTER", "GROWER")

    def test_day_24_never_changes_stage(self):
        self._assert_observe_only(24, "GROWER", "FINISHER")

    def test_no_alert_without_confident_readings(self):
        cases = {
            "low confidence": [("GROWER", 55.0, False)] * 6,
            "current stage": [("STARTER", 90.0, True)] * 6,
            "not consecutive": [("GROWER", 90.0, True), ("GROWER", 90.0, True), ("STARTER", 90.0, True)] * 2,
            "no reading": [(None, None, False)] * 6,
        }
        for name, readings in cases.items():
            attempt, ran = run_window(10, "STARTER", readings, pre_check="GROWER")
            self.assertEqual((attempt["result"], ran), ("not_ready", ss.DAILY_MAX_CYCLES), name)
            s = ss.schedule_status(START, "STARTER", at(day_n(10), 11), attempt)
            self.assertIsNone(s["readyAlert"], name)

    def test_alert_clears_when_stage_changes(self):
        attempt, _ = run_window(10, "STARTER", CONFIDENT_GROWER, pre_check="GROWER")
        s = ss.schedule_status(START, "GROWER", at(day_n(10), 12), attempt)  # set by hand
        self.assertIsNone(s["readyAlert"])
        # Day 11's real check replaces the pre-check attempt.
        check, _ = run_window(11, "STARTER", [("STARTER", 70.0, True)])
        s = ss.schedule_status(START, "STARTER", at(day_n(11), 10, 1), check)
        self.assertIsNone(s["readyAlert"])
        self.assertEqual(check["kind"], "check")

    def test_still_starter_on_day_24_gets_grower_check(self):
        # Owner decision 2: no Finisher pre-check for a late Starter flock.
        self.assertIsNone(ss.pre_check_target(24, "STARTER"))
        s = ss.schedule_status(START, "STARTER", at(day_n(24), 8), None)
        self.assertEqual((s["phase"], s["allowedTargets"], s["preCheckStage"]), ("grower_check", ["GROWER"], None))

    def test_grower_confirmed_after_day_24_has_no_pre_check(self):
        # Owner decision 3.
        self.assertIsNone(ss.pre_check_target(26, "GROWER"))
        s = ss.schedule_status(START, "GROWER", at(day_n(26), 8), None)
        self.assertEqual((s["phase"], s["allowedTargets"]), ("finisher_check", ["FINISHER"]))

    def test_pre_checks_can_be_turned_off(self):
        old = ss.PRE_CHECK_DAYS_BEFORE
        try:
            ss.PRE_CHECK_DAYS_BEFORE = 0
            self.assertIsNone(ss.pre_check_target(10, "STARTER"))
            self.assertFalse(ss.window_due(at(day_n(10), 10), START, "STARTER", None))
            s = ss.schedule_status(START, "STARTER", at(day_n(5)), None)
            self.assertEqual(s["nextCheckAt"], at(day_n(11), 10).isoformat())
            self.assertEqual(s["preCheckDays"], {})
        finally:
            ss.PRE_CHECK_DAYS_BEFORE = old


class GateDays(unittest.TestCase):
    def test_grower_only_from_day_11(self):
        for day in range(1, 11):
            self.assertNotIn("GROWER", ss.allowed_targets(day, "STARTER"), day)
        self.assertEqual(ss.allowed_targets(11, "STARTER"), ("GROWER",))
        attempt, ran = run_window(11, "STARTER", CONFIDENT_GROWER, applied_on=2)
        self.assertEqual((attempt["result"], attempt["target"], ran), ("confirmed", "GROWER", 3))

    def test_finisher_only_from_day_25(self):
        for day in range(11, 25):
            self.assertNotIn("FINISHER", ss.allowed_targets(day, "GROWER"), day)
        self.assertEqual(ss.allowed_targets(25, "GROWER"), ("FINISHER",))


class QuietPeriods(unittest.TestCase):
    def test_no_checks_between_grower_and_day_23(self):
        for day in range(11, 24):
            for hh, mm in ((10, 0), (10, 30)):
                self.assertFalse(ss.window_due(at(day_n(day), hh, mm), START, "GROWER", None), day)
            s = ss.schedule_status(START, "GROWER", at(day_n(day), 8), None)
            self.assertEqual(s["nextCheckAt"], at(day_n(24), 10).isoformat(), day)
        self.assertTrue(ss.window_due(at(day_n(24), 10), START, "GROWER", None))

    def test_no_checks_after_finisher(self):
        for day in range(25, 50):
            self.assertFalse(ss.window_due(at(day_n(day), 10), START, "FINISHER", None), day)
            s = ss.schedule_status(START, "FINISHER", at(day_n(day), 8), None)
            self.assertEqual((s["phase"], s["nextCheckAt"], s["readyAlert"]), ("complete", None, None))


class LateFlock(unittest.TestCase):
    def _late(self, current, first_day, stage):
        attempt = None
        for offset in range(4):  # Days N, N+1, N+2, N+3: re-checked every day, no cap
            day = first_day + offset
            self.assertTrue(ss.window_due(at(day_n(day), 10), START, current, attempt), day)
            attempt, ran = run_window(day, current, [(current, 70.0, True)] * 10)
            self.assertEqual((attempt["result"], ran), ("not_confirmed", ss.DAILY_MAX_CYCLES))
            s = ss.schedule_status(START, current, at(day_n(day), 12), attempt)
            self.assertEqual((s["overdueStage"], s["overdueDays"]), (stage, offset + 1))
            self.assertEqual(s["nextCheckAt"], at(day_n(day + 1), 10).isoformat())

    def test_late_grower_rechecked_daily(self):
        self._late("STARTER", 11, "GROWER")  # Days 11, 12, 13, 14

    def test_late_finisher_rechecked_daily(self):
        self._late("GROWER", 25, "FINISHER")  # Days 25, 26, 27, 28


class Countdown(unittest.TestCase):
    """The dashboard counts down to `nextCheckAt` (it never recomputes it)."""

    def test_next_check_follows_the_schedule(self):
        cases = [
            ("STARTER", 1, 8, 10),   # Days 1-9 -> Day 10 pre-check
            ("STARTER", 9, 23, 10),
            ("STARTER", 10, 9, 10),  # Day 10 before 10:00 -> today
            ("STARTER", 10, 12, 11),  # Day 10 after 11:00, no pre-check ran -> Day 11
            ("GROWER", 12, 8, 24),   # Grower -> Day 24 pre-check
            ("GROWER", 24, 9, 24),
            ("GROWER", 24, 12, 25),
        ]
        for stage, day, hh, expected in cases:
            s = ss.schedule_status(START, stage, at(day_n(day), hh), None)
            self.assertEqual(s["nextCheckAt"], at(day_n(expected), 10).isoformat(), (stage, day, hh))


if __name__ == "__main__":
    unittest.main()
