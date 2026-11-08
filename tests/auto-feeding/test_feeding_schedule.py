"""Unit tests for raspberry-pi/feeding_schedule.py (SPEC-auto-feeding.md).

Run: python -m unittest discover -s tests/auto-feeding -v
"""
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "raspberry-pi"))

import feeding_schedule as fs  # noqa: E402

TZ = fs.TZ
DAY = date(2026, 11, 8)
GROWER_TIMES = ["06:00", "10:00", "14:00", "18:00"]


def at(hh, mm=0, d=DAY):
    return datetime(d.year, d.month, d.day, hh, mm, tzinfo=TZ)


def samples(values, newest_age=1.0, step=2.0, now=100.0):
    """values oldest -> newest, one every `step` s, the newest `newest_age` s old."""
    n = len(values)
    return [(now - newest_age - (n - 1 - i) * step, v) for i, v in enumerate(values)]


class TroughValid(unittest.TestCase):
    def test_stable_reading(self):
        r = fs.trough_valid(samples([40, 42, 41, 43, 40]), 100.0)
        self.assertTrue(r["valid"], r)
        self.assertEqual(r["grams"], 41)

    def test_small_negative_clamped_to_zero(self):
        r = fs.trough_valid(samples([-10, -12, -8, -11, -9]), 100.0)
        self.assertTrue(r["valid"], r)
        self.assertEqual(r["grams"], 0)

    def test_clearly_negative_invalid(self):
        r = fs.trough_valid(samples([-263, -280, -270, -275, -268]), 100.0)
        self.assertFalse(r["valid"])
        self.assertEqual(r["reason"], "negative")

    def test_sensor_noise_is_valid(self):
        # Real trough noise on 2026-11-08 (empty trough, grams vs the median).
        r = fs.trough_valid(samples([-29, 8, 18, -28, 13]), 100.0)
        self.assertTrue(r["valid"], r)
        self.assertEqual(r["grams"], 8)

    def test_noisy_invalid(self):
        r = fs.trough_valid(samples([40, 120, 41, 43, -30]), 100.0)
        self.assertFalse(r["valid"])
        self.assertEqual(r["reason"], "unstable")

    def test_too_few_or_stale(self):
        self.assertEqual(fs.trough_valid(samples([40, 41, 42, 40]), 100.0)["reason"], "too_few_samples")
        self.assertEqual(fs.trough_valid(samples([40, 41, 42, 40, 41], newest_age=6.0, step=0.5), 100.0)["reason"], "stale")
        # samples older than the 30 s window are ignored
        old = samples([40, 41, 42, 40, 41], newest_age=40.0)
        self.assertEqual(fs.trough_valid(old, 100.0)["reason"], "too_few_samples")
        self.assertEqual(fs.trough_valid([], 100.0)["reason"], "too_few_samples")

    def test_non_numbers_ignored(self):
        bad = samples([40, None, 41, float("nan"), 42, 40, 41], step=1.0)
        r = fs.trough_valid(bad, 100.0)
        self.assertTrue(r["valid"], r)

    def test_uncommissioned(self):
        r = fs.trough_valid(samples([40, 41, 42, 40, 41]), 100.0, commissioned=False)
        self.assertFalse(r["valid"])
        self.assertEqual(r["reason"], "not_commissioned")


class SessionNeed(unittest.TestCase):
    RATE = 103.0

    def test_dispense_difference(self):
        r = fs.session_need(157.5, 40, self.RATE)
        self.assertEqual((r["action"], r["grams"], r["partial"]), ("dispense", 117.5, False))
        self.assertAlmostEqual(r["seconds"], 117.5 / self.RATE, places=3)

    def test_empty_trough_full_target(self):
        r = fs.session_need(157.5, 0, self.RATE)
        self.assertEqual((r["action"], r["grams"]), ("dispense", 157.5))

    def test_skip_at_or_above_target(self):
        for trough in (157.5, 200):
            r = fs.session_need(157.5, trough, self.RATE)
            self.assertEqual((r["action"], r["reason"]), ("skip", "trough_at_target"))
            self.assertEqual(r["grams"], 0)

    def test_skip_too_small(self):
        r = fs.session_need(157.5, 140, self.RATE)  # 17.5 g < 20 g
        self.assertEqual((r["action"], r["reason"]), ("skip", "too_small"))
        r = fs.session_need(157.5, 137.5, self.RATE)  # exactly 20 g dispenses
        self.assertEqual(r["action"], "dispense")

    def test_partial_cap(self):
        r = fs.session_need(1500, 0, self.RATE)
        self.assertEqual((r["action"], r["partial"]), ("dispense", True))
        self.assertAlmostEqual(r["seconds"], fs.MAX_DISPENSE_SECONDS)
        self.assertAlmostEqual(r["grams"], round(fs.MAX_DISPENSE_SECONDS * self.RATE, 1))

    def test_bad_inputs(self):
        self.assertEqual(fs.session_need(None, 0, self.RATE)["reason"], "no_target")
        self.assertEqual(fs.session_need(0, 0, self.RATE)["reason"], "no_target")
        self.assertEqual(fs.session_need(157.5, 0, 0)["reason"], "bad_rate")
        self.assertEqual(fs.session_need(157.5, None, self.RATE)["reason"], "no_trough")


class DueSession(unittest.TestCase):
    def test_window(self):
        self.assertEqual(fs.due_session(at(13, 59), GROWER_TIMES, set())["due"], None)
        self.assertEqual(fs.due_session(at(14, 0), GROWER_TIMES, set())["due"], "14:00")
        self.assertEqual(fs.due_session(at(14, 14), GROWER_TIMES, set())["due"], "14:00")
        r = fs.due_session(at(14, 15), GROWER_TIMES, set())
        self.assertEqual(r["due"], None)
        self.assertIn("14:00", r["missed"])

    def test_done_not_due_again(self):
        r = fs.due_session(at(14, 5), GROWER_TIMES, {"06:00", "10:00", "14:00"})
        self.assertEqual((r["due"], r["missed"]), (None, []))

    def test_missed_earlier_sessions(self):
        r = fs.due_session(at(11, 0), GROWER_TIMES, set())
        self.assertEqual(r["missed"], ["06:00", "10:00"])
        self.assertIsNone(r["due"])
        r = fs.due_session(at(10, 3), GROWER_TIMES, {"06:00"})
        self.assertEqual((r["due"], r["missed"]), ("10:00", []))

    def test_next(self):
        self.assertEqual(fs.due_session(at(11, 0), GROWER_TIMES, set())["next"], at(14).isoformat())
        r = fs.due_session(at(19, 0), GROWER_TIMES, {"06:00", "10:00", "14:00", "18:00"})
        self.assertEqual(r["next"], at(6, d=DAY + timedelta(days=1)).isoformat())
        self.assertIsNone(fs.due_session(at(9), [], set())["next"])

    def test_bad_times_ignored(self):
        r = fs.due_session(at(10, 1), ["10:00", "25:00", "x", None], set())
        self.assertEqual(r["due"], "10:00")


class Sessions(unittest.TestCase):
    def test_record_done_and_persist(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "feeding_sessions.json"
            self.assertEqual(fs.load_sessions(path), [])
            rec = fs.make_record(at(10, 0, ), "10:00", "GROWER", 157.5, 40, 117.5, "dispensed", None)
            sessions = fs.add_record([], rec, DAY)
            fs.save_sessions(path, sessions)
            loaded = fs.load_sessions(path)
            self.assertEqual(loaded, sessions)
            self.assertEqual(fs.done_times(loaded, DAY), {"10:00"})
            self.assertEqual(fs.done_times(loaded, DAY + timedelta(days=1)), set())
            path.write_text("{bad")
            self.assertEqual(fs.load_sessions(path), [])
            path.write_text(json.dumps([{"date": "x"}, "junk", rec]))
            self.assertEqual(fs.load_sessions(path), [rec])

    def test_prune_old_days(self):
        old = fs.make_record(at(10, d=DAY - timedelta(days=8)), "10:00", "GROWER", 1, 0, 1, "dispensed", None)
        keep = fs.make_record(at(10, d=DAY - timedelta(days=6)), "10:00", "GROWER", 1, 0, 1, "dispensed", None)
        new = fs.make_record(at(10), "10:00", "GROWER", 1, 0, 1, "dispensed", None)
        sessions = fs.add_record([old, keep], new, DAY)
        self.assertEqual(sessions, [keep, new])

    def test_fault_streak(self):
        def r(result):
            return {"result": result}
        self.assertEqual(fs.fault_streak([]), 0)
        self.assertEqual(fs.fault_streak([r("fault"), r("fault")]), 2)
        # skips and misses don't break or count
        self.assertEqual(fs.fault_streak([r("fault"), r("skipped"), r("fault"), r("missed"), r("fault")]), 3)
        # a good dispense resets
        self.assertEqual(fs.fault_streak([r("fault"), r("fault"), r("dispensed"), r("fault")]), 1)
        self.assertEqual(fs.fault_streak([r("fault"), r("partial")]), 0)
        self.assertTrue(fs.should_disable([r("fault")] * 3))
        self.assertFalse(fs.should_disable([r("fault")] * 2))


if __name__ == "__main__":
    unittest.main()
