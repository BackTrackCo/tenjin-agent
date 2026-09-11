"""The shipped Bench-1 tasks, lessons and hidden verifier, independent of run selections."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from evals.benchmark import FIXTURES, artifact, tenjin_arm, verifier
from evals.benchmark.tests import support
from evals.benchmark.tests.corpus_support import actor_failure_key
from evals.benchmark.tests.test_verifier import _write_marker, run_dir

ACTOR_FIXTURE = FIXTURES / "live" / "actor"


def test_the_node_test_verifier_decides_from_its_hidden_layer_and_fails_closed_without_it(run_dir: Path) -> None:
    spec = verifier.lookup("node_test_actor")
    roots = artifact.create(run_dir, "trial-node", ACTOR_FIXTURE)
    roots.mark_stopped()
    copy = roots.hidden_copy(spec.hidden_layer)
    # The hidden layer is on the copy and nowhere near the agent's mount.
    assert (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").is_file()
    assert not (roots.repo / verifier.HIDDEN_TESTS).exists()
    unfixed = verifier.run(spec, copy, run_dir)
    assert (unfixed.outcome, unfixed.exit_code) == ("fail", 1)
    (copy / "src" / "actor.mjs").write_text("export function actorKey(session, agent) {\n  return `${session}:${agent ?? 'root'}`;\n}\n", encoding="utf-8")
    # A correct edit alone is not a pass: the named test has to have run green in the trial.
    unrun = verifier.run(spec, copy, run_dir)
    assert (unrun.outcome, unrun.exit_code) == ("fail", 1)
    assert "no run marker" in unrun.detail
    _write_marker(copy, "actor", files=["tests/actor.test.mjs"])
    assert verifier.run(spec, copy, run_dir).outcome == "pass"
    (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").unlink()
    undecided = verifier.run(spec, copy, run_dir)
    assert (undecided.outcome, undecided.exit_code) == ("invalid", 3)


def test_the_package_test_script_never_forwards_the_file_argument(tmp_path: Path) -> None:
    # The trap, on a fake vitest that records its argv: `pnpm test -- <file>`
    # reaches `scripts/all-tests.mjs`, and the file never reaches vitest.
    trap = tmp_path / "trap"
    (trap / "scripts").mkdir(parents=True)
    (trap / "node_modules" / "vitest").mkdir(parents=True)
    shutil.copy(ACTOR_FIXTURE / "scripts" / "all-tests.mjs", trap / "scripts" / "all-tests.mjs")
    (trap / "node_modules" / "vitest" / "vitest.mjs").write_text(
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        ["node", "scripts/all-tests.mjs", "--", "tests/actor.test.mjs"],
        cwd=trap,
        env=verifier.child_environment(),
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    assert completed.returncode == 1, completed.stderr
    assert json.loads((trap / "argv.json").read_text(encoding="utf-8")) == ["run"]
    assert "not forwarded" in completed.stderr


@pytest.mark.parametrize(
    ("through_pnpm", "extra"),
    [
        pytest.param(False, {}, id="bare node"),
        pytest.param(False, {"npm_config_user_agent": "npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false"}, id="npx"),
        pytest.param(True, {"npm_config_user_agent": "pnpm/11.0.0 npm/? node/v24.0.0 darwin arm64"}, id="pnpm"),
    ],
)
def test_the_vitest_config_refuses_a_runner_that_did_not_come_through_pnpm(tmp_path: Path, through_pnpm: bool, extra: dict) -> None:
    config = tmp_path / "config"
    config.mkdir()
    shutil.copy(ACTOR_FIXTURE / "vitest.config.mjs", config / "vitest.config.mjs")
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", "await import('./vitest.config.mjs')"],
        cwd=config,
        env={**verifier.child_environment(), **extra},
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    if through_pnpm:
        assert completed.returncode == 0, completed.stderr
    else:
        assert completed.returncode == 1
        assert support.PNPM_GUARD_MESSAGE in completed.stderr
        assert "pnpm exec" not in completed.stderr


def test_the_live_lesson_is_loadable_and_its_keys_are_the_fixture_failures() -> None:
    live = tenjin_arm.FIXTURES / "live" / "lessons"
    lessons = tenjin_arm.lessons_for({"id": "actor", "family": "test-harness-convention"}, live)
    assert [lesson.id for lesson in lessons] == ["test-harness-convention", "actor-fix"]
    convention, fix = lessons
    assert convention.keys == ("sig_v1:ee9fd96defcffbeb",)
    assert [entry.command for entry in convention.commands if entry.check and entry.key is None] == ["pnpm test -- tests/{task}.test.mjs"]
    assert "pnpm exec vitest run" in convention.body.read_text(encoding="utf-8")
    # The fix lesson carries the key run seven's fires table recorded for this failure.
    assert fix.keys == (actor_failure_key(),)
    assert tenjin_arm.key_hash("sig_v1:ee9fd96defcffbeb") == "ed094b3427f6e7e2"
    assert "s9" not in fix.body.read_text(encoding="utf-8")
    assert tenjin_arm.lessons_for({"id": "answer-file", "family": "smoke"}, live) == []
