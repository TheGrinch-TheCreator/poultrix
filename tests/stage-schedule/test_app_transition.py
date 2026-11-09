"""The real transition rule from raspberry-pi/app.py, with the hardware stubbed.

app.py needs a camera, serial port and YOLO, so it can't be imported on a dev
machine. This test extracts `evaluate_stage_transition` and
`reset_transition_candidate` from its source (ast) and runs them against fake
state, so it checks the code that actually ships (SPEC-stage-schedule §4, §10).

Run: python -m unittest discover -s tests/stage-schedule -v
"""
import ast
import pathlib
import sys
import threading
import unittest
from datetime import date, datetime, timedelta

PI = pathlib.Path(__file__).resolve().parents[2] / "raspberry-pi"
sys.path.insert(0, str(PI))

import stage_schedule as ss  # noqa: E402

START = date(2026, 11, 1)
FUNCTIONS = ("evaluate_stage_transition", "reset_transition_candidate")


def load_rule(stage, day):
    """Fresh namespace with app.py's transition functions, today = batch `day`."""
    tree = ast.parse((PI / "app.py").read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in FUNCTIONS]
    assert sorted(n.name for n in nodes) == sorted(FUNCTIONS), "functions not found in app.py"
    now = datetime.combine(START + timedelta(days=day - 1), datetime.min.time().replace(hour=10), tzinfo=ss.TZ)

    class Clock:  # stage_schedule with a fixed "now"
        def __getattr__(self, name):
            return getattr(ss, name)

        @staticmethod
        def local_now():
            return now

    applied = []

    def apply_confirmed_stage_to_arduino(target):
        applied.append(target)
        ns["state"]["stage"] = target
        return {"success": True}

    ns = {
        "state": {"stage": stage}, "state_lock": threading.Lock(),
        "ai_state": {"transitionCandidate": None, "transitionConfirmations": 0, "transitionConfirmed": False,
                     "confirmedTransitionStage": None, "transitionStatus": None},
        "ai_state_lock": threading.Lock(),
        "stage_schedule": Clock(),
        "batch_start_date": lambda: START.isoformat(),
        "AI_TRANSITION_CONFIRMATIONS_REQUIRED": ss.CONFIRMATIONS_REQUIRED,
        "apply_confirmed_stage_to_arduino": apply_confirmed_stage_to_arduino,
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "app.py", "exec"), ns)
    return ns, applied


class AnalyzeNow(unittest.TestCase):
    def test_analyze_now_never_changes_the_stage(self):
        for stage, day, seen in (("STARTER", 12, "GROWER"), ("GROWER", 30, "FINISHER"), ("STARTER", 10, "GROWER")):
            ns, applied = load_rule(stage, day)
            for _ in range(10):
                result = ns["evaluate_stage_transition"](seen, True, scheduled=False)
                self.assertEqual(result["status"], "manual_check_only")
                self.assertFalse(result["confirmed"])
            self.assertEqual((applied, ns["state"]["stage"]), ([], stage))


class PreCheckDays(unittest.TestCase):
    def test_pre_check_days_never_apply(self):
        for stage, day, seen in (("STARTER", 10, "GROWER"), ("GROWER", 24, "FINISHER")):
            ns, applied = load_rule(stage, day)
            for _ in range(10):
                result = ns["evaluate_stage_transition"](seen, True, scheduled=True)
                self.assertEqual(result["status"], "not_allowed_yet")
            self.assertEqual((applied, ns["state"]["stage"]), ([], stage))

    def test_gate_days_apply_after_three(self):
        for stage, day, seen in (("STARTER", 11, "GROWER"), ("GROWER", 25, "FINISHER")):
            ns, applied = load_rule(stage, day)
            statuses = [ns["evaluate_stage_transition"](seen, True, scheduled=True)["status"]
                        for _ in range(ss.CONFIRMATIONS_REQUIRED)]
            self.assertEqual(statuses[:-1], ["pending"] * (ss.CONFIRMATIONS_REQUIRED - 1))
            self.assertEqual((applied, ns["state"]["stage"]), ([seen], seen))


if __name__ == "__main__":
    unittest.main()
