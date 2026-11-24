"""The 30-second AI vote (raspberry-pi/ai_votes.py) and the maintenance vote
simulator in raspberry-pi/app.py.

app.py needs a camera, serial port and YOLO, so it can't be imported on a dev
machine. The session code is extracted from its source (ast) and run against a
fake Arduino, so the tests check the code that actually ships. The 30 s window
is shortened to a fraction of a second.

Run: python -m unittest discover -s tests/ai-votes -v
"""
import ast
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest

PI = pathlib.Path(__file__).resolve().parents[2] / "raspberry-pi"
sys.path.insert(0, str(PI))

import ai_votes as av  # noqa: E402
import stage_schedule as ss  # noqa: E402

MIN_CONF, MIN_FRAMES, MIN_FRACTION = 60.0, 10, 0.60


def tally(votes, confidences=None):
    return av.tally(votes, confidences, MIN_CONF, MIN_FRAMES, MIN_FRACTION)


class Tally(unittest.TestCase):
    def test_camera_cycle_rules_unchanged(self):
        # Same outcomes as the inline rule run_ai_cycle had before.
        confident = tally({"Starter": 2, "Grower": 25, "Finisher": 3},
                          {"Starter": [70, 70], "Grower": [80] * 25, "Finisher": [65] * 3})
        self.assertEqual((confident["stage"], confident["confident"], confident["status"]), ("Grower", True, "ready"))
        self.assertAlmostEqual(confident["confidence"], 80.0)
        low_conf = tally({"Starter": 0, "Grower": 20, "Finisher": 0}, {"Grower": [55] * 20})
        self.assertEqual((low_conf["confident"], low_conf["status"]), (False, "low_confidence"))
        split = tally({"Starter": 9, "Grower": 11, "Finisher": 10}, {"Starter": [90] * 9, "Grower": [90] * 11, "Finisher": [90] * 10})
        self.assertFalse(split["confident"])  # 11/30 < 60 %
        few = tally({"Starter": 0, "Grower": 9, "Finisher": 0}, {"Grower": [99] * 9})
        self.assertFalse(few["confident"])  # fewer than 10 frames

    def test_tie_is_rejected(self):
        result = tally({"Starter": 15, "Grower": 15, "Finisher": 0}, {"Starter": [90] * 15, "Grower": [90] * 15})
        self.assertEqual((result["stage"], result["status"]), (None, "tie"))

    def test_simulated_votes_have_no_confidence(self):
        result = tally({"Starter": 0, "Grower": 0, "Finisher": 80})
        self.assertEqual((result["stage"], result["confidence"], result["confident"], result["frames"]),
                         ("Finisher", None, True, 80))
        self.assertFalse(tally({"Starter": 0, "Grower": 5, "Finisher": 0})["confident"])
        self.assertEqual(tally(av.empty_votes())["status"], "no_votes")


class VoteCount(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(av.parse_vote_count(None), av.SIM_VOTES_DEFAULT)
        for value, expected in ((1, 1), (80, 80), (300, 300), (80.0, 80)):
            self.assertEqual(av.parse_vote_count(value), expected)

    def test_invalid(self):
        for value in (0, -5, 301, 10**9, 2.5, float("nan"), float("inf"), True, "80", [], {}):
            with self.assertRaises(ValueError, msg=repr(value)):
                av.parse_vote_count(value)

    def test_offsets_fill_the_window(self):
        offsets = av.vote_offsets(80, 30)
        self.assertEqual(len(offsets), 80)
        self.assertEqual(offsets[0], 0)
        self.assertTrue(all(0 <= a < b < 30 for a, b in zip(offsets, offsets[1:])))
        self.assertEqual(av.vote_offsets(1, 30), [0])


FUNCTIONS = {"stage_session_snapshot", "stage_session_token_valid", "record_stage_session",
             "run_simulated_vote_session", "apply_confirmed_stage_to_arduino", "reset_transition_candidate",
             "_manual_history", "active_stage_preset", "stage_preset_snapshot", "clear_stage_preset",
             "run_preset_camera_check", "evaluate_preset_transition"}
NAMES = {"AI_RESULT_FIELDS", "STAGE_HANDOFF_ERRORS"}
CLASSES = {"VoteSessionCancelled"}
WINDOW = 0.4  # seconds, instead of 30


class FakePi:
    """app.py's session code with a fake Arduino that acknowledges STAGE:."""

    def __init__(self, stage="GROWER", online=True, ack=True, feeding=False):
        tree = ast.parse((PI / "app.py").read_text(encoding="utf-8"))
        nodes = [n for n in tree.body if
                 (isinstance(n, ast.FunctionDef) and n.name in FUNCTIONS)
                 or (isinstance(n, ast.ClassDef) and n.name in CLASSES)
                 or (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in NAMES for t in n.targets))]
        found = {getattr(n, "name", None) or n.targets[0].id for n in nodes}
        assert found == FUNCTIONS | NAMES | CLASSES, f"missing in app.py: {FUNCTIONS | NAMES | CLASSES - found}"
        self.tmp = tempfile.TemporaryDirectory()
        self.sent = []
        self.ack = ack
        ns = self.ns = {
            "threading": threading, "time": time, "json": json, "os": __import__("os"), "ai_votes": av,
            "stage_schedule": ss, "AI_TRANSITION_CONFIRMATIONS_REQUIRED": ss.CONFIRMATIONS_REQUIRED,
            "state": {"stage": stage}, "state_lock": threading.Lock(),
            "ai_state": {"status": "ready", "detectedStage": "Grower", "confidence": 88.5, "confident": True,
                         "lastInference": "2026-11-24T02:00:00+00:00", "inferenceTimeMs": 120.0, "cycleDuration": 30.0,
                         "framesAnalyzed": 30, "failedFrames": 0, "votes": {"Starter": 0, "Grower": 30, "Finisher": 0},
                         "error": None, "source": "camera", "framesExpected": 30, "cycleRunning": False,
                         "transitionCandidate": "FINISHER", "transitionConfirmations": 2, "transitionConfirmed": False,
                         "confirmedTransitionStage": None, "transitionStatus": "pending", "transitionSource": "camera",
                         "hardwareTransitionStatus": "idle", "hardwareTransitionError": None,
                         "lastHardwareTransition": None, "lastTransitionResult": None},
            "ai_state_lock": threading.Lock(), "ai_cycle_lock": threading.Lock(),
            "bypass_lock": threading.RLock(), "bypass_token": "tok", "bypass_expires": time.monotonic() + 3600,
            "feeding_lock": threading.Lock(), "feeding_pending": None, "feeding_gates": {1: {"status": "DISPENSING" if feeding else "IDLE"}},
            "arduino_online_locked": lambda: online, "controller_ready_locked": lambda: online,
            "bypass_active": lambda: True, "AI_AUTO_STAGE_TRANSITIONS": True,
            "AI_STAGE_ACK_TIMEOUT_SECONDS": 0.3, "AI_CYCLE_DURATION_SECONDS": WINDOW,
            "AI_MIN_CONFIDENCE": MIN_CONF, "AI_MIN_VALID_FRAMES": MIN_FRAMES, "AI_MIN_WINNING_VOTE_FRACTION": MIN_FRACTION,
            "STAGE_MANUAL_PATH": pathlib.Path(self.tmp.name) / "stage_manual.json", "STAGE_MANUAL_HISTORY": 20,
            "utc_timestamp": lambda: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()) + f".{time.monotonic_ns()}",
            "send_command": self.send_command, "print": lambda *a, **k: None,
            "stage_session_lock": threading.Lock(), "stage_preset_lock": threading.Lock(), "stage_preset": None,
            "stage_session": {"id": 0, "status": "idle", "stage": None, "votes": None, "submitted": 0, "from": None,
                              "result": None, "error": None, "startedAt": None, "finishedAt": None},
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "app.py", "exec"), ns)

    def send_command(self, command):
        self.sent.append(command)
        if self.ack and command.startswith("STAGE:"):
            self.ns["state"]["stage"] = command.split(":", 1)[1]
        return True

    def run(self, target, votes, cancel_after=None, confidence=None):
        """Like the route: take the cycle lock, then run the session."""
        assert self.ns["ai_cycle_lock"].acquire(blocking=False)
        if cancel_after is not None:
            def cancel():
                time.sleep(cancel_after)
                with self.ns["bypass_lock"]:
                    self.ns["bypass_token"] = None  # Exit bypass
            threading.Thread(target=cancel, daemon=True).start()
        self.ns["run_simulated_vote_session"](target, votes, "tok", "ip:test", confidence)
        return self.ns["stage_session_snapshot"]()

    def runs(self, target, votes, times, confidence=None):
        """`times` preset checks in a row; their results."""
        return [self.run(target, votes, confidence=confidence)["result"] for _ in range(times)]

    def history(self):
        return self.ns["_manual_history"]()

    def close(self):
        self.tmp.cleanup()


class VoteSession(unittest.TestCase):
    def setUp(self):
        self.pis = []

    def tearDown(self):
        for pi in self.pis:
            pi.close()

    def pi(self, **kwargs):
        pi = FakePi(**kwargs)
        self.pis.append(pi)
        return pi

    def test_votes_reach_the_shared_ai_state_and_apply_the_stage(self):
        pi = self.pi(stage="GROWER")
        self.assertEqual(pi.runs("FINISHER", 80, ss.CONFIRMATIONS_REQUIRED - 1),
                         ["pending"] * (ss.CONFIRMATIONS_REQUIRED - 1))
        self.assertEqual((pi.sent, pi.ns["state"]["stage"]), ([], "GROWER"))
        session = pi.run("FINISHER", 80)
        ai = pi.ns["ai_state"]
        self.assertEqual((session["result"], session["confirmations"]), ("applied", ss.CONFIRMATIONS_REQUIRED))
        self.assertEqual(session["submitted"], 80)
        self.assertEqual(ai["votes"], {"Starter": 0, "Grower": 0, "Finisher": 80})
        self.assertEqual((ai["detectedStage"], ai["framesAnalyzed"], ai["framesExpected"]), ("Finisher", 80, 80))
        self.assertEqual((ai["status"], ai["confident"], ai["confidence"]), ("ready", True, None))
        self.assertEqual(ai["source"], av.SOURCE_SIMULATED)
        self.assertFalse(ai["cycleRunning"])
        self.assertEqual(pi.ns["state"]["stage"], "FINISHER")
        self.assertEqual(pi.sent, ["STAGE:FINISHER"])
        self.assertEqual(ai["lastTransitionResult"]["status"], "applied")
        # A new stage starts a fresh scheduled candidate.
        self.assertEqual((ai["transitionCandidate"], ai["transitionConfirmations"], ai["transitionStatus"]),
                         (None, 0, "applied"))
        self.assertFalse(pi.ns["ai_cycle_lock"].locked())
        entry = pi.history()[-1]
        self.assertEqual((entry["source"], entry["stage"], entry["votes"], entry["result"], entry["from"], entry["to"],
                          entry["confirmations"], entry["required"]),
                         (av.SOURCE_SIMULATED, "FINISHER", 80, "applied", "GROWER", "FINISHER",
                          ss.CONFIRMATIONS_REQUIRED, ss.CONFIRMATIONS_REQUIRED))
        self.assertEqual([h["result"] for h in pi.history()],
                         ["pending"] * (ss.CONFIRMATIONS_REQUIRED - 1) + ["applied"])

    def test_votes_take_the_whole_window_and_arrive_gradually(self):
        pi = self.pi()
        seen = []
        stop = threading.Event()

        def watch():
            while not stop.is_set():
                with pi.ns["ai_state_lock"]:
                    seen.append(pi.ns["ai_state"]["framesAnalyzed"])
                time.sleep(0.02)
        watcher = threading.Thread(target=watch)
        watcher.start()
        started = time.monotonic()
        pi.run("GROWER", 40)
        elapsed = time.monotonic() - started
        stop.set()
        watcher.join()
        self.assertGreaterEqual(elapsed, WINDOW)
        self.assertTrue(any(0 < n < 40 for n in seen), "votes should be published as they land")

    def test_backwards_is_allowed_for_the_owner(self):
        pi = self.pi(stage="FINISHER")
        self.assertEqual(pi.runs("STARTER", 30, ss.CONFIRMATIONS_REQUIRED)[-1], "applied")
        self.assertEqual(pi.ns["state"]["stage"], "STARTER")

    def test_same_stage_changes_nothing_on_the_arduino(self):
        pi = self.pi(stage="GROWER")
        session = pi.run("GROWER", 30)
        self.assertEqual(session["result"], "unchanged")
        self.assertEqual(pi.sent, [])
        # The real scheduled candidate is left alone.
        self.assertEqual((pi.ns["ai_state"]["transitionConfirmations"], pi.ns["ai_state"]["transitionSource"]),
                         (2, "camera"))

    def test_too_few_votes_never_confirms(self):
        pi = self.pi(stage="GROWER")
        session = pi.run("FINISHER", 9)
        self.assertEqual(session["result"], "not_confirmed")
        self.assertEqual((pi.ns["ai_state"]["status"], pi.ns["ai_state"]["confident"]), ("low_confidence", False))
        self.assertEqual((pi.sent, pi.ns["state"]["stage"]), ([], "GROWER"))

    def test_no_ack_and_feeding_are_reported(self):
        pi = self.pi(stage="GROWER", ack=False)
        pi.runs("FINISHER", 30, ss.CONFIRMATIONS_REQUIRED - 1)
        session = pi.run("FINISHER", 30)
        self.assertEqual((session["result"], session["error"]), ("failed", "Arduino did not confirm the new stage"))
        # Still confirmed: the next check tries the hand-off again.
        pi.ack = True
        self.assertEqual(pi.run("FINISHER", 30)["result"], "applied")
        pi = self.pi(stage="GROWER", feeding=True)
        pi.runs("FINISHER", 30, ss.CONFIRMATIONS_REQUIRED - 1)
        session = pi.run("FINISHER", 30)
        self.assertEqual(session["result"], "failed")
        self.assertIn("dispensed", session["error"])
        self.assertEqual(pi.ns["state"]["stage"], "GROWER")

    def test_exit_cancels_and_restores_the_previous_result(self):
        pi = self.pi(stage="GROWER")
        before = {k: pi.ns["ai_state"][k] for k in pi.ns["AI_RESULT_FIELDS"]}
        session = pi.run("FINISHER", 80, cancel_after=WINDOW / 3)
        self.assertEqual(session["result"], "cancelled")
        after = {k: pi.ns["ai_state"][k] for k in pi.ns["AI_RESULT_FIELDS"]}
        self.assertEqual(after, before)
        self.assertEqual((pi.sent, pi.ns["state"]["stage"], pi.history()), ([], "GROWER", []))
        self.assertFalse(pi.ns["ai_cycle_lock"].locked())

    def test_several_sessions_in_a_row(self):
        pi = self.pi(stage="STARTER")
        steps = (("GROWER", 30, "pending"), ("GROWER", 30, "pending"), ("GROWER", 30, "applied"),
                 ("GROWER", 50, "unchanged"), ("FINISHER", 5, "not_confirmed"), ("FINISHER", 120, "pending"),
                 ("FINISHER", 120, "pending"), ("FINISHER", 120, "applied"))
        for target, votes, result in steps:
            session = pi.run(target, votes)
            self.assertEqual(session["result"], result, (target, votes))
            self.assertEqual(sum(pi.ns["ai_state"]["votes"].values()), votes)
            self.assertEqual(pi.ns["ai_state"]["framesExpected"], votes)
        self.assertEqual(pi.ns["state"]["stage"], "FINISHER")
        self.assertEqual([h["result"] for h in pi.history()], [result for _, _, result in steps])

    def test_three_in_a_row_are_needed(self):
        pi = self.pi(stage="GROWER")
        # A low-confidence check in between starts the count again.
        self.assertEqual(pi.runs("FINISHER", 30, 2), ["pending", "pending"])
        self.assertEqual(pi.run("FINISHER", 30, confidence=40.0)["result"], "not_confirmed")
        self.assertEqual(pi.runs("FINISHER", 30, 2), ["pending", "pending"])
        self.assertEqual(pi.ns["state"]["stage"], "GROWER")
        # Changing the preset stage restarts the count too.
        self.assertEqual(pi.run("STARTER", 30)["confirmations"], 1)
        self.assertEqual(pi.runs("STARTER", 30, 2), ["pending", "applied"])
        self.assertEqual(pi.ns["state"]["stage"], "STARTER")

    def test_pending_is_shown_like_a_camera_candidate(self):
        pi = self.pi(stage="GROWER")
        pi.run("FINISHER", 30)
        ai = pi.ns["ai_state"]
        self.assertEqual((ai["transitionCandidate"], ai["transitionConfirmations"], ai["transitionStatus"],
                          ai["transitionSource"]), ("FINISHER", 1, "pending", av.SOURCE_SIMULATED))
        self.assertEqual(pi.ns["stage_session_snapshot"]()["confirmations"], 1)

    def test_camera_confirmations_never_count_for_a_preset(self):
        # The harness starts with a real camera candidate FINISHER at 2/3.
        pi = self.pi(stage="GROWER")
        session = pi.run("FINISHER", 30)
        self.assertEqual((session["result"], session["confirmations"]), ("pending", 1))
        self.assertEqual(pi.sent, [])

    def test_a_same_stage_check_leaves_a_camera_candidate_alone(self):
        pi = self.pi(stage="GROWER")
        pi.run("STARTER", 5)  # not confirmed
        pi.run("GROWER", 30)  # same stage
        ai = pi.ns["ai_state"]
        self.assertEqual((ai["transitionCandidate"], ai["transitionConfirmations"], ai["transitionSource"]),
                         ("FINISHER", 2, "camera"))

    def test_clearing_the_preset_drops_a_pending_preset_candidate(self):
        pi = self.pi(stage="GROWER")
        pi.runs("FINISHER", 30, 2)
        pi.ns["clear_stage_preset"]()
        ai = pi.ns["ai_state"]
        self.assertEqual((ai["transitionCandidate"], ai["transitionConfirmations"]), (None, 0))
        self.assertEqual(pi.run("FINISHER", 30)["confirmations"], 1)

    def test_session_and_camera_cycle_share_one_lock(self):
        pi = self.pi()
        assert pi.ns["ai_cycle_lock"].acquire(blocking=False)  # a camera cycle is running
        self.assertFalse(pi.ns["ai_cycle_lock"].acquire(blocking=False))  # route would answer 409
        pi.ns["ai_cycle_lock"].release()

    def test_ai_transition_path_is_unchanged(self):
        # Scheduled AI hand-off (owner=False) still refuses during maintenance.
        pi = self.pi(stage="GROWER")
        result = pi.ns["apply_confirmed_stage_to_arduino"]("FINISHER")
        self.assertEqual(result["status"], "hardware_busy_or_offline")
        self.assertEqual(pi.sent, [])


class PresetCameraCheck(unittest.TestCase):
    """Main-app Camera check while a maintenance preset is stored."""

    def setUp(self):
        self.pi = FakePi(stage="GROWER")

    def tearDown(self):
        self.pi.close()

    def store(self, stage, votes):
        self.pi.ns["stage_preset"] = {"stage": stage, "votes": votes, "setAt": "t", "by": "ip:test", "token": "tok"}

    def check(self):
        preset = self.pi.ns["active_stage_preset"]()
        self.assertIsNotNone(preset)
        return self.pi.ns["run_preset_camera_check"](preset, "owner@example")

    def test_preset_runs_the_vote_and_applies_the_stage(self):
        self.store("FINISHER", 80)
        for count in range(1, ss.CONFIRMATIONS_REQUIRED):
            pending = self.check()
            self.assertEqual((pending["success"], pending["transition"]["status"], pending["transition"]["confirmations"]),
                             (True, "pending", count))
            self.assertEqual(self.pi.ns["state"]["stage"], "GROWER")
        result = self.check()
        self.assertTrue(result["success"])
        self.assertEqual((result["detectedStage"], result["confident"], result["status"], result["confidence"]),
                         ("Finisher", True, "ready", None))
        self.assertEqual(result["votes"], {"Starter": 0, "Grower": 0, "Finisher": 80})
        self.assertEqual(result["framesAnalyzed"], 80)
        self.assertEqual((result["transition"]["status"], result["transition"]["confirmations"]),
                         ("applied", ss.CONFIRMATIONS_REQUIRED))
        self.assertEqual(self.pi.ns["state"]["stage"], "FINISHER")
        entry = self.pi.history()[-1]
        self.assertEqual((entry["trigger"], entry["by"], entry["source"]), ("camera_check", "owner@example", av.SOURCE_SIMULATED))
        self.assertFalse(self.pi.ns["ai_cycle_lock"].locked())

    def test_preset_stays_for_every_check_until_cleared(self):
        self.store("GROWER", 40)
        for _ in range(2):
            self.assertEqual(self.check()["transition"]["status"], "unchanged")
        self.pi.ns["clear_stage_preset"]()
        self.assertIsNone(self.pi.ns["active_stage_preset"]())

    def test_preset_ends_with_the_maintenance_login(self):
        self.store("FINISHER", 80)
        self.pi.ns["bypass_token"] = None  # Exit bypass
        self.assertIsNone(self.pi.ns["active_stage_preset"]())
        self.store("FINISHER", 80)
        self.pi.ns["bypass_token"] = "tok"
        self.pi.ns["bypass_expires"] = time.monotonic() - 1  # session expired
        self.assertIsNone(self.pi.ns["active_stage_preset"]())

    def test_snapshot_hides_the_token(self):
        self.store("STARTER", 30)
        snap = self.pi.ns["stage_preset_snapshot"]()
        self.assertEqual((snap["stage"], snap["votes"]), ("STARTER", 30))
        self.assertNotIn("token", snap)

    def test_busy_while_another_cycle_runs(self):
        self.store("FINISHER", 80)
        self.pi.ns["ai_cycle_lock"].acquire()
        result = self.check()
        self.assertEqual((result["success"], result.get("busy")), (False, True))
        self.pi.ns["ai_cycle_lock"].release()
        self.assertEqual(self.pi.ns["state"]["stage"], "GROWER")


class PresetConfidence(unittest.TestCase):
    """The optional confidence set with a maintenance preset."""

    def setUp(self):
        self.pi = FakePi(stage="GROWER")

    def tearDown(self):
        self.pi.close()

    def test_parse(self):
        for value, expected in ((None, None), ("", None), (87.5, 87.5), (100, 100.0), (60.004, 60.0), (0.1, 0.1)):
            self.assertEqual(av.parse_confidence(value), expected, value)
        for value in (0, -1, 100.01, float("nan"), float("inf"), True, "90", []):
            with self.assertRaises(ValueError, msg=repr(value)):
                av.parse_confidence(value)

    def test_every_vote_carries_the_confidence(self):
        self.assertIsNone(av.simulated_confidences({"Starter": 0, "Grower": 3, "Finisher": 0}, None))
        self.assertEqual(av.simulated_confidences({"Starter": 0, "Grower": 3, "Finisher": 0}, 90.0),
                         {"Starter": [], "Grower": [90.0] * 3, "Finisher": []})

    def test_confidence_reaches_the_result_and_history(self):
        self.assertEqual(self.pi.runs("FINISHER", 80, ss.CONFIRMATIONS_REQUIRED, confidence=87.5)[-1], "applied")
        ai = self.pi.ns["ai_state"]
        self.assertEqual((ai["confidence"], ai["confident"], ai["status"]), (87.5, True, "ready"))
        self.assertEqual(self.pi.history()[-1]["confidence"], 87.5)

    def test_low_confidence_never_confirms(self):
        session = self.pi.run("FINISHER", 80, confidence=45.0)
        ai = self.pi.ns["ai_state"]
        self.assertEqual(session["result"], "not_confirmed")
        self.assertEqual((ai["confidence"], ai["confident"], ai["status"]), (45.0, False, "low_confidence"))
        self.assertEqual((self.pi.sent, self.pi.ns["state"]["stage"]), ([], "GROWER"))

    def test_threshold_is_inclusive_like_the_camera(self):
        self.assertEqual(self.pi.runs("FINISHER", 30, ss.CONFIRMATIONS_REQUIRED, confidence=60.0)[-1], "applied")

    def test_camera_check_returns_the_preset_confidence(self):
        self.pi.ns["stage_preset"] = {"stage": "GROWER", "votes": 30, "confidence": 92.3, "setAt": "t",
                                      "by": "ip:test", "token": "tok"}
        result = self.pi.ns["run_preset_camera_check"](self.pi.ns["active_stage_preset"](), "owner@example")
        self.assertEqual((result["confidence"], result["status"], result["transition"]["status"]),
                         (92.3, "ready", "unchanged"))
        self.assertEqual(self.pi.ns["stage_preset_snapshot"]()["confidence"], 92.3)

    def test_no_confidence_still_works(self):
        session = self.pi.run("GROWER", 30)
        self.assertEqual((session["result"], self.pi.ns["ai_state"]["confidence"]), ("unchanged", None))
        self.assertIsNone(self.pi.history()[-1]["confidence"])


def function_body(src, name):
    """Source of one top-level function in app.py."""
    node = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == name)
    return ast.get_source_segment(src, node)


class AppWiring(unittest.TestCase):
    """Static checks on app.py for the parts the fake can't run."""

    src = (PI / "app.py").read_text(encoding="utf-8")

    def test_camera_cycle_uses_the_shared_tally_and_tags_its_source(self):
        cycle = self.src[self.src.index("def run_ai_cycle("):self.src.index("def run_scheduled_check(")]
        self.assertIn("ai_votes.tally(votes, confidence_by_stage", cycle)
        self.assertIn('ai_state["source"] = ai_votes.SOURCE_CAMERA', cycle)
        self.assertIn("remember_agreeing_detection(", cycle)

    def test_simulated_results_never_feed_camera_records(self):
        session = function_body(self.src, "run_simulated_vote_session")
        self.assertNotIn("remember_agreeing_detection", session)
        self.assertNotIn("classify_current_frame", session)
        self.assertIn("(source IS NULL OR source = ?)", self.src)
        self.assertIn('ai.get("source") or ai_votes.SOURCE_CAMERA', self.src)

    def test_camera_check_uses_preset_only_when_stored(self):
        route = self.src[self.src.index("def manual_ai_classification("):self.src.index("# API: MODE SWITCHING")]
        self.assertIn("preset = active_stage_preset()", route)
        self.assertIn("run_preset_camera_check(preset, request_user())", route)
        self.assertIn("else run_ai_cycle()", route)
        # Scheduled daily checks and maintenance "Analyse real stage" stay on the camera.
        for name in ("run_scheduled_check", "bypass_analyse_real"):
            body = function_body(self.src, name)
            self.assertIn("run_ai_cycle(", body)
            self.assertNotIn("preset", body)

    def test_preset_cleared_when_maintenance_ends(self):
        for name in ("bypass_return_live", "bypass_shutdown"):
            self.assertIn("clear_stage_preset()", function_body(self.src, name), name)

    def test_real_rule_counts_only_camera_confirmations(self):
        body = function_body(self.src, "evaluate_stage_transition")
        self.assertIn('ai_state.get("transitionSource", ai_votes.SOURCE_CAMERA) == ai_votes.SOURCE_CAMERA', body)
        self.assertIn('ai_state["transitionSource"] = ai_votes.SOURCE_CAMERA', body)

    def test_stage_constants_match(self):
        self.assertEqual(tuple(s.title() for s in ss.STAGES), av.STAGE_NAMES)


if __name__ == "__main__":
    unittest.main()
