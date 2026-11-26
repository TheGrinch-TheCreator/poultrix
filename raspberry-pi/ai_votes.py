"""The 30-second AI vote, shared by real camera cycles and the maintenance
vote simulator (Confirm stage on the maintenance site). Standard library only,
so it is unit-tested on a dev machine (tests/ai-votes/).

A camera cycle samples one frame a second for 30 s; each classified frame is
one vote. The maintenance simulator submits a chosen number of votes per
stage (e.g. 2 Starter, 17 Grower, 9 Finisher) over the same 30 s window, in a
random order, like frames from a camera. Both are judged by `tally`.
"""

import random

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


def parse_confidence(value):
    """Optional confidence % for simulated votes (owner, 2026-11-24): None or
    "" means none; otherwise a number above 0 and at most 100, rounded to 2
    decimals. It goes through the same confidence rule as the camera."""
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Confidence must be a number")
    value = float(value)
    if value != value or not 0 < value <= 100:
        raise ValueError("Confidence must be above 0 and at most 100")
    return round(value, 2)


def simulated_confidences(votes, confidence):
    """The per-vote confidences `tally` expects for simulated votes: every
    vote carries the preset confidence, or None when no confidence was set."""
    if confidence is None:
        return None
    return {name: [confidence] * count for name, count in votes.items()}


def parse_vote_counts(value):
    """Votes per stage for a preset (owner, 2026-11-26), e.g.
    {"STARTER": 2, "GROWER": 17, "FINISHER": 9}. Keys are stage names in any
    case; a missing stage is 0. Each count and the total must be whole numbers,
    the total SIM_VOTES_MIN..SIM_VOTES_MAX. A tie is allowed (owner,
    2026-11-26): it ends like a tied camera vote and never confirms a stage.
    Returns (winning stage in uppercase or None for a tie, {"Starter": n, ...},
    total)."""
    if not isinstance(value, dict):
        raise ValueError("Votes must give a number for each stage")
    counts = empty_votes()
    for key, count in value.items():
        name = str(key).strip().title()
        if name not in counts:
            raise ValueError("Votes must be for Starter, Grower or Finisher")
        if isinstance(count, bool) or not isinstance(count, (int, float)):
            raise ValueError("Votes must be whole numbers")
        if isinstance(count, float):
            if count != count or count in (float("inf"), float("-inf")) or not count.is_integer():
                raise ValueError("Votes must be whole numbers")
            count = int(count)
        if count < 0:
            raise ValueError("Votes can't be negative")
        counts[name] = count
    total = sum(counts.values())
    if not SIM_VOTES_MIN <= total <= SIM_VOTES_MAX:
        raise ValueError(f"Total votes must be {SIM_VOTES_MIN} to {SIM_VOTES_MAX}")
    top = max(counts.values())
    winners = [name for name, count in counts.items() if count == top]
    return (winners[0].upper() if len(winners) == 1 else None), counts, total


PRESET_QUEUE_MAX = 30  # presets in one Use list (the gateway limits a body to 4 KB)
PRESET_NAME_MAX = 40


def parse_preset_queue(value):
    """The ordered presets a Use press sends (owner, 2026-11-26): each Camera
    check uses one, then the next; after the last it starts over.
    value: [{"name"?, "votes": {STAGE: n}, "confidence"?}, ...], 1 to
    PRESET_QUEUE_MAX entries. Returns [{"name", "stage", "counts", "votes",
    "confidence"}]; raises ValueError naming the bad entry."""
    if not isinstance(value, list) or not 1 <= len(value) <= PRESET_QUEUE_MAX:
        raise ValueError(f"A preset list must have 1 to {PRESET_QUEUE_MAX} presets")
    queue = []
    for number, entry in enumerate(value, 1):
        if not isinstance(entry, dict):
            raise ValueError(f"Preset {number} is not valid")
        try:
            stage, counts, total = parse_vote_counts(entry.get("votes"))
            confidence = parse_confidence(entry.get("confidence"))
        except ValueError as exc:
            raise ValueError(f"Preset {number}: {exc}") from None
        name = entry.get("name")
        name = str(name).strip()[:PRESET_NAME_MAX] if isinstance(name, str) and name.strip() else None
        queue.append({"name": name, "stage": stage, "counts": counts, "votes": total, "confidence": confidence})
    return queue


LIBRARY_MAX_PRESETS = 200
LIBRARY_FILTERS = ("STARTER", "GROWER", "FINISHER", "TIE", "NONE")


def parse_preset_library(value):
    """The saved presets of the maintenance site and each filter's order
    (owner, 2026-11-26: shared by every device, so they live on the Pi).
    value: {"presets": [{"id", "name", "counts": {STAGE: n}, "confidence"?,
    "category"?}], "orders": {FILTER: [id, ...]}}. The presets list is the
    "All" order. Returns the cleaned library; raises ValueError."""
    if not isinstance(value, dict) or not isinstance(value.get("presets"), list):
        raise ValueError("The preset list is not valid")
    raw_presets = value["presets"]
    if len(raw_presets) > LIBRARY_MAX_PRESETS:
        raise ValueError(f"At most {LIBRARY_MAX_PRESETS} saved presets")
    presets, ids = [], set()
    for number, entry in enumerate(raw_presets, 1):
        if not isinstance(entry, dict):
            raise ValueError(f"Saved preset {number} is not valid")
        preset_id = entry.get("id")
        if (not isinstance(preset_id, str) or not 1 <= len(preset_id) <= 40
                or not all(c.isascii() and (c.isalnum() or c in "-_") for c in preset_id) or preset_id in ids):
            raise ValueError(f"Saved preset {number} has no valid id")
        ids.add(preset_id)
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"Saved preset {number} needs a name")
        try:
            _, counts, _ = parse_vote_counts(entry.get("counts"))
            confidence = parse_confidence(entry.get("confidence"))
        except ValueError as exc:
            raise ValueError(f"Saved preset {number}: {exc}") from None
        category = entry.get("category")
        if category is not None and category not in LIBRARY_FILTERS:
            raise ValueError(f"Saved preset {number} has an unknown filter")
        preset = {"id": preset_id, "name": name.strip()[:PRESET_NAME_MAX],
                  "counts": {name_.upper(): count for name_, count in counts.items()}, "confidence": confidence}
        if category is not None:
            preset["category"] = category
        presets.append(preset)
    raw_orders = value.get("orders")
    raw_orders = {} if raw_orders is None else raw_orders
    if not isinstance(raw_orders, dict):
        raise ValueError("The filter orders are not valid")
    orders = {}
    for key, order in raw_orders.items():
        if key not in LIBRARY_FILTERS or not isinstance(order, list):
            raise ValueError("The filter orders are not valid")
        # Ids of deleted presets are dropped; duplicates keep their first place.
        orders[key] = list(dict.fromkeys(item for item in order if isinstance(item, str) and item in ids))
    return {"presets": presets, "orders": orders}


def vote_sequence(counts, rng=random):
    """The stage of each simulated vote, in a random order (shuffled, so the
    stages are mixed like camera frames instead of one block per stage)."""
    sequence = [name for name in STAGE_NAMES for _ in range(counts.get(name, 0))]
    rng.shuffle(sequence)
    return sequence


def vote_offsets(count, duration_seconds, rng=None):
    """When each simulated vote is submitted, in seconds from the cycle start:
    spread over the window, the first at 0 like the first camera frame. With
    rng, each later vote lands up to 35 % of a slot early or late (still in
    order and inside the window), like the uneven timing of camera frames."""
    step = duration_seconds / count
    if rng is None:
        return [step * index for index in range(count)]
    return [0.0] + [step * (index + rng.uniform(-0.35, 0.35)) for index in range(1, count)]


HISTORY_DELETE_MAX = 100  # AI checks deleted in one request from the maintenance site


def parse_check_ids(value):
    """The AI-check history rows to delete (owner, 2026-11-26): a list of 1 to
    HISTORY_DELETE_MAX positive whole-number ids. Returns them unique and
    sorted; raises ValueError."""
    if not isinstance(value, list) or not 1 <= len(value) <= HISTORY_DELETE_MAX:
        raise ValueError(f"Choose 1 to {HISTORY_DELETE_MAX} checks to delete")
    ids = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise ValueError("Check ids must be positive whole numbers")
        ids.add(item)
    return sorted(ids)
