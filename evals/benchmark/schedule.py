"""Balanced, seeded schedule expansion.

The expanded schedule is the authority on resume, so it is written with its
SHA-256 before the first attempt. `trial_id` derives from the manifest hash,
task, arm, repeat, and schedule position, never from a clock.

Balance is a property of the expansion, not of luck: the arm order is one
seeded permutation rotated by (repeat + the task's manifest index), so across
repeats each arm occupies each position inside a task block within one of
every other arm. `expand` refuses to return a schedule that misses that bar.
"""

from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path

from . import canonical_json, sha256_json, sha256_text
from .manifest import Manifest


class ScheduleError(ValueError):
    pass


@dataclass(frozen=True)
class Trial:
    trial_id: str
    task_id: str
    arm_id: str
    repeat: int
    position: int


def trial_id(manifest_hash: str, task_id: str, arm_id: str, repeat: int, position: int) -> str:
    return sha256_text(canonical_json([manifest_hash, task_id, arm_id, repeat, position]))[:24]


def expand(manifest: Manifest) -> list[Trial]:
    """Seeded task order, rotated arm order, one trial per (task, arm, repeat)."""
    rng = random.Random(manifest.data["seed"])
    tasks = [task["id"] for task in manifest.tasks]
    index = {task_id: position for position, task_id in enumerate(tasks)}
    arms = [arm["id"] for arm in manifest.arms]
    rng.shuffle(arms)
    trials: list[Trial] = []
    position = 0
    for repeat in range(manifest.data["repeats"]):
        order = list(tasks)
        rng.shuffle(order)
        for task_id in order:
            # Rotate by the task's manifest index rather than its shuffled
            # position: the shuffle would make the rotation random too, and
            # random rotations are only balanced on average.
            offset = (repeat + index[task_id]) % len(arms)
            for arm_id in arms[offset:] + arms[:offset]:
                trials.append(
                    Trial(
                        trial_id=trial_id(manifest.hash, task_id, arm_id, repeat, position),
                        task_id=task_id,
                        arm_id=arm_id,
                        repeat=repeat,
                        position=position,
                    )
                )
                position += 1
    check_balance(trials, arms)
    return trials


def arm_positions(trials: list[Trial]) -> dict[tuple[str, str], dict[int, int]]:
    """Per (task, arm): how often that arm ran at each slot inside a task block."""
    slots: dict[tuple[str, int], int] = {}
    counts: dict[tuple[str, str], dict[int, int]] = {}
    for trial in trials:
        block = (trial.task_id, trial.repeat)
        slot = slots.get(block, 0)
        slots[block] = slot + 1
        per_arm = counts.setdefault((trial.task_id, trial.arm_id), {})
        per_arm[slot] = per_arm.get(slot, 0) + 1
    return counts


def check_balance(trials: list[Trial], arms: list[str]) -> None:
    """Arm positions per task differ by at most one, or the schedule is refused."""
    for (task_id, arm_id), per_arm in sorted(arm_positions(trials).items()):
        counts = [per_arm.get(slot, 0) for slot in range(len(arms))]
        if max(counts) - min(counts) > 1:
            raise ScheduleError(f"task {task_id!r} arm {arm_id!r} is unbalanced across positions: {counts}")


def schedule_hash(trials: list[Trial]) -> str:
    return sha256_json([asdict(trial) for trial in trials])


def write(run_dir: Path, manifest: Manifest, trials: list[Trial]) -> str:
    digest = schedule_hash(trials)
    payload = {
        "manifest_hash": manifest.hash,
        "schedule_hash": digest,
        "trials": [asdict(trial) for trial in trials],
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "schedule.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    (run_dir / "schedule.sha256").write_text(digest + "\n", encoding="utf-8")
    return digest
