"""The frozen schedule: seeded, reproducible, balanced, and written before spend."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals.benchmark import schedule
from evals.benchmark.manifest import Manifest
from evals.benchmark.schedule import ScheduleError, Trial
from evals.benchmark.tests import support


def test_same_seed_reproduces_ids_and_order(tmp_path: Path) -> None:
    first = schedule.expand(support.synthetic_manifest(tmp_path, tasks=4, repeats=3, seed=11))
    second = schedule.expand(support.synthetic_manifest(tmp_path, tasks=4, repeats=3, seed=11))
    assert first == second
    assert schedule.schedule_hash(first) == schedule.schedule_hash(second)
    assert [trial.position for trial in first] == list(range(len(first)))
    assert len({trial.trial_id for trial in first}) == len(first)


def test_a_different_seed_changes_the_order(tmp_path: Path) -> None:
    first = schedule.expand(support.synthetic_manifest(tmp_path, tasks=4, repeats=3, seed=11))
    second = schedule.expand(support.synthetic_manifest(tmp_path, tasks=4, repeats=3, seed=12))
    assert [(trial.task_id, trial.arm_id) for trial in first] != [(trial.task_id, trial.arm_id) for trial in second]
    # The same cells, in another order: a seed reorders work, never changes it.
    assert sorted((trial.task_id, trial.arm_id, trial.repeat) for trial in first) == sorted(
        (trial.task_id, trial.arm_id, trial.repeat) for trial in second
    )


@pytest.mark.parametrize("repeats", (3, 4, 7))
def test_arm_positions_are_balanced_across_repeats(tmp_path: Path, repeats: int) -> None:
    trials = schedule.expand(support.synthetic_manifest(tmp_path, tasks=3, repeats=repeats, seed=5))
    counts = schedule.arm_positions(trials)
    assert len(counts) == 3 * 2
    for (task_id, arm_id), per_arm in counts.items():
        slots = [per_arm.get(slot, 0) for slot in range(2)]
        assert max(slots) - min(slots) <= 1, f"{task_id}/{arm_id} {slots}"
        assert sum(slots) == repeats


def test_three_arms_stay_balanced(tmp_path: Path) -> None:
    trials = schedule.expand(support.synthetic_manifest(tmp_path, tasks=2, repeats=6, arms=("off", "on", "oracle"), seed=3))
    for (task_id, arm_id), per_arm in schedule.arm_positions(trials).items():
        assert [per_arm.get(slot, 0) for slot in range(3)] == [2, 2, 2], f"{task_id}/{arm_id}"


def test_check_balance_refuses_an_unbalanced_schedule() -> None:
    def block(repeat: int, order: list[str]) -> list[Trial]:
        return [
            Trial(trial_id=f"t{repeat}{slot}", task_id="task-0", arm_id=arm, repeat=repeat, position=repeat * 2 + slot)
            for slot, arm in enumerate(order)
        ]

    rotated = block(0, ["off", "on"]) + block(1, ["on", "off"]) + block(2, ["off", "on"])
    schedule.check_balance(rotated, ["off", "on"])
    # 'off' first in every repeat: the arm and the position are confounded,
    # which is the shape the seed exists to prevent.
    fixed = block(0, ["off", "on"]) + block(1, ["off", "on"]) + block(2, ["off", "on"])
    with pytest.raises(ScheduleError):
        schedule.check_balance(fixed, ["off", "on"])


def test_trial_ids_follow_the_manifest_hash(tmp_path: Path) -> None:
    manifest = support.synthetic_manifest(tmp_path, tasks=2, repeats=2, seed=9)
    first = schedule.expand(manifest)
    second = schedule.expand(Manifest(data=manifest.data, path=manifest.path, hash="sha256:another-manifest"))
    assert [(trial.task_id, trial.arm_id) for trial in first] == [(trial.task_id, trial.arm_id) for trial in second]
    assert all(a.trial_id != b.trial_id for a, b in zip(first, second))


def test_the_schedule_and_its_hash_are_written_before_the_first_attempt(tmp_path: Path) -> None:
    manifest = support.synthetic_manifest(tmp_path, tasks=2, repeats=2, seed=4)
    trials = schedule.expand(manifest)
    run_dir = tmp_path / "run"
    digest = schedule.write(run_dir, manifest, trials)
    payload = json.loads((run_dir / "schedule.json").read_text(encoding="utf-8"))
    assert payload["schedule_hash"] == digest
    assert payload["manifest_hash"] == manifest.hash
    assert (run_dir / "schedule.sha256").read_text(encoding="utf-8").strip() == digest
    assert [item["trial_id"] for item in payload["trials"]] == [trial.trial_id for trial in trials]
