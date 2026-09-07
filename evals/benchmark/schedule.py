"""Balanced, seeded schedule expansion.

The expanded schedule is the authority on resume, so it is written with its
SHA-256 before the first attempt. `trial_id` derives from the manifest hash,
task, arm, repeat, and schedule position, never from a clock.
"""

from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path

from . import canonical_json, sha256_json, sha256_text
from .manifest import Manifest


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
    """Rotate arm order per (repeat, task) so arm positions differ by at most one."""
    rng = random.Random(manifest.data["seed"])
    tasks = [task["id"] for task in manifest.tasks]
    arms = [arm["id"] for arm in manifest.arms]
    trials: list[Trial] = []
    position = 0
    for repeat in range(manifest.data["repeats"]):
        order = list(tasks)
        rng.shuffle(order)
        for index, task_id in enumerate(order):
            offset = (repeat + index) % len(arms)
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
    return trials


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
