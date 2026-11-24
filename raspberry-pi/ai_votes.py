"""The 30-second AI vote, shared by real camera cycles and the maintenance
vote simulator (Confirm stage on the maintenance site). Standard library only,
so it is unit-tested on a dev machine (tests/ai-votes/).

A camera cycle samples one frame a second for 30 s; each classified frame is
one vote. The maintenance simulator submits a chosen number of votes for one
stage over the same 30 s window. Both are judged by `tally`.
"""

STAGE_NAMES = ("Starter", "Grower", "Finisher")

# Where a vote result came from. Stored in ai_state["source"] and in the
# history database (ai_checks.source), never shown in the main app.
SOURCE_CAMERA = "camera"
SOURCE_SIMULATED = "bypass_simulation"

# Simulated votes per session. One camera cycle gives at most 30 votes
# (one per second); the simulator allows more for testing, up to 10 a second.
SIM_VOTES_MIN = 1
SIM_VOTES_MAX = 300
SIM_VOTES_DEFAULT = 30


def empty_votes():
    return {name: 0 for name in STAGE_NAMES}


def tally(votes, confidences, min_confidence, min_frames, min_fraction):
    """Judge one cycle's votes.

    votes: {"Starter": n, "Grower": n, "Finisher": n}.
    confidences: {stage: [model confidence % per winning frame]} for camera
    cycles, or None for simulated votes. Simulated votes have no model
    confidence, so none is invented: the result's confidence is None and the
    confidence rule is skipped. The vote-count rules still apply.

    A tie is rejected rather than guessed.
    """
    frames = sum(votes.values())
    if frames == 0:
        return {"stage": None, "confidence": None, "confident": False, "status": "no_votes", "frames": 0}
    top = max(votes.values())
    winners = [name for name, count in votes.items() if count == top]
    if len(winners) != 1:
        return {"stage": None, "confidence": None, "confident": False, "status": "tie", "frames": frames}
    stage = winners[0]
    confidence = None
    if confidences is not None:
        values = confidences.get(stage) or []
        confidence = sum(values) / len(values) if values else 0.0
    confident = ((confidence is None or confidence >= min_confidence)
                 and frames >= min_frames
                 and top / frames >= min_fraction)
    return {"stage": stage, "confidence": confidence, "confident": confident,
            "status": "ready" if confident else "low_confidence", "frames": frames}


def parse_vote_count(value):
    """A whole number of votes in SIM_VOTES_MIN..SIM_VOTES_MAX; None means the
    default. Raises ValueError for anything else (bools, text, fractions)."""
    if value is None:
        return SIM_VOTES_DEFAULT
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Votes must be a whole number")
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")) or not value.is_integer():
            raise ValueError("Votes must be a whole number")
        value = int(value)
    if not SIM_VOTES_MIN <= value <= SIM_VOTES_MAX:
        raise ValueError(f"Votes must be {SIM_VOTES_MIN} to {SIM_VOTES_MAX}")
    return value


def vote_offsets(count, duration_seconds):
    """When each simulated vote is submitted, in seconds from the cycle start:
    evenly spread over the window, the first at 0 like the first camera frame."""
    return [duration_seconds * index / count for index in range(count)]
