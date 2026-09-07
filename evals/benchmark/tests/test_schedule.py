"""The frozen schedule: seeded, reproducible, balanced, and written before spend."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import schedule
from evals.benchmark.manifest import Manifest
from evals.benchmark.schedule import ScheduleError, Trial
from evals.benchmark.tests import support


class ScheduleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_same_seed_reproduces_ids_and_order(self) -> None:
        first = schedule.expand(support.synthetic_manifest(self.dir, tasks=4, repeats=3, seed=11))
        second = schedule.expand(support.synthetic_manifest(self.dir, tasks=4, repeats=3, seed=11))
        self.assertEqual(first, second)
        self.assertEqual(schedule.schedule_hash(first), schedule.schedule_hash(second))
        self.assertEqual([trial.position for trial in first], list(range(len(first))))
        self.assertEqual(len({trial.trial_id for trial in first}), len(first))

    def test_a_different_seed_changes_the_order(self) -> None:
        first = schedule.expand(support.synthetic_manifest(self.dir, tasks=4, repeats=3, seed=11))
        second = schedule.expand(support.synthetic_manifest(self.dir, tasks=4, repeats=3, seed=12))
        self.assertNotEqual([(trial.task_id, trial.arm_id) for trial in first], [(trial.task_id, trial.arm_id) for trial in second])
        # The same cells, in another order: a seed reorders work, never changes it.
        self.assertEqual(
            sorted((trial.task_id, trial.arm_id, trial.repeat) for trial in first),
            sorted((trial.task_id, trial.arm_id, trial.repeat) for trial in second),
        )

    def test_arm_positions_are_balanced_across_repeats(self) -> None:
        for repeats in (3, 4, 7):
            with self.subTest(repeats=repeats):
                trials = schedule.expand(support.synthetic_manifest(self.dir, tasks=3, repeats=repeats, seed=5))
                counts = schedule.arm_positions(trials)
                self.assertEqual(len(counts), 3 * 2)
                for (task_id, arm_id), per_arm in counts.items():
                    slots = [per_arm.get(slot, 0) for slot in range(2)]
                    self.assertLessEqual(max(slots) - min(slots), 1, f"{task_id}/{arm_id} {slots}")
                    self.assertEqual(sum(slots), repeats)

    def test_three_arms_stay_balanced(self) -> None:
        trials = schedule.expand(support.synthetic_manifest(self.dir, tasks=2, repeats=6, arms=("off", "on", "oracle"), seed=3))
        for (task_id, arm_id), per_arm in schedule.arm_positions(trials).items():
            slots = [per_arm.get(slot, 0) for slot in range(3)]
            self.assertEqual(slots, [2, 2, 2], f"{task_id}/{arm_id}")

    def test_check_balance_refuses_an_unbalanced_schedule(self) -> None:
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
        with self.assertRaises(ScheduleError):
            schedule.check_balance(fixed, ["off", "on"])

    def test_trial_ids_follow_the_manifest_hash(self) -> None:
        manifest = support.synthetic_manifest(self.dir, tasks=2, repeats=2, seed=9)
        first = schedule.expand(manifest)
        second = schedule.expand(Manifest(data=manifest.data, path=manifest.path, hash="sha256:another-manifest"))
        self.assertEqual([(trial.task_id, trial.arm_id) for trial in first], [(trial.task_id, trial.arm_id) for trial in second])
        self.assertTrue(all(a.trial_id != b.trial_id for a, b in zip(first, second)))

    def test_the_schedule_and_its_hash_are_written_before_the_first_attempt(self) -> None:
        manifest = support.synthetic_manifest(self.dir, tasks=2, repeats=2, seed=4)
        trials = schedule.expand(manifest)
        run_dir = self.dir / "run"
        digest = schedule.write(run_dir, manifest, trials)
        payload = json.loads((run_dir / "schedule.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["schedule_hash"], digest)
        self.assertEqual(payload["manifest_hash"], manifest.hash)
        self.assertEqual((run_dir / "schedule.sha256").read_text(encoding="utf-8").strip(), digest)
        self.assertEqual([item["trial_id"] for item in payload["trials"]], [trial.trial_id for trial in trials])


if __name__ == "__main__":
    unittest.main()
