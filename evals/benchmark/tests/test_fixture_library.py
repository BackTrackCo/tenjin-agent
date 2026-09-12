"""The full shared task and lesson library; no experiment manifest is loaded."""
from __future__ import annotations
import dataclasses
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest import mock
import pytest
from evals.benchmark import artifact, cases, claude_live, cli, images, manifest as manifest_module, signature, tenjin_arm, verifier
from evals.benchmark.tests import support, corpus_support
from evals.benchmark.tests.test_verifier import run_dir, repo, _write_marker

LIVE = cli.FIXTURES / "live"
ACTOR_FIXTURE = LIVE / "actor"
CATALOG = json.loads((LIVE / "catalog.json").read_text())["tasks"]


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
        assert corpus_support.PNPM_GUARD_MESSAGE in completed.stderr
        assert "pnpm exec" not in completed.stderr


@pytest.mark.parametrize("task", sorted(verifier.TASK_PACKAGES))
def test_every_task_verifier_fails_its_unfixed_fixture_from_its_own_hidden_layer(task: str, run_dir: Path, tmp_path: Path) -> None:
    live = verifier.HIDDEN.parent / "fixtures" / "live"
    spec = verifier.lookup(f"node_test_{task}")
    # The committed fixture without its dependency tree: a hidden
    # test imports the source, or the workspace package a consumer
    # imports, and never a dependency, so the 24 MB vitest tree an
    # image holds is not needed and is not copied ten times.
    copy = tmp_path / f"fixture-{task}"
    shutil.copytree(live / task, copy, ignore=shutil.ignore_patterns("node_modules"))
    roots = artifact.create(run_dir, f"trial-{task}", copy)
    corpus_support.link_workspace_packages(roots.repo)
    roots.mark_stopped()
    verdict = verifier.run(spec, roots.hidden_copy(spec.hidden_layer), run_dir)
    assert (verdict.outcome, verdict.exit_code) == ("fail", 1)


def actor_failure_key() -> str:
    """The `sig_v1_test` key the actor fixture's own failing case yields.

    Unfixed, `actorKey` interpolates a missing agent, so the hidden case
    that passes no agent is the one vitest names in its FAIL header. The
    file, the title template and the case index all come off the fixture,
    and the product's own console rule turns the header into the key, so a
    regenerated fixture moves the lesson and this expectation together.
    """
    test_file = tenjin_arm.FIXTURES / "live" / "actor" / "tests" / "actor.test.mjs"
    template = re.search(r"test\.each\(cases\)\('([^']+)'", test_file.read_text(encoding="utf-8"))
    hidden = json.loads((verifier.HIDDEN / "actor" / "cases.json").read_text(encoding="utf-8"))
    assert template is not None
    index = next(position for position, case in enumerate(hidden) if len(case["args"]) == 1)
    identity = signature.identity_from_console(f" FAIL  tests/{test_file.name} > {template.group(1).replace('%#', str(index))}")
    assert identity is not None
    return f"sig_v1_test:{signature.sig_v1_test(identity)}"


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


def test_every_lesson_is_loadable_and_keyed_apart_from_the_others() -> None:
    keys: dict[str, str] = {}
    for path in sorted(tenjin_arm.LESSONS.glob("*.json")):
        lesson = tenjin_arm.lesson_named(path.stem)
        assert lesson is not None
        assert "http" not in lesson.body.read_text(encoding="utf-8")
        for key in set(lesson.keys):
            # One key, one lesson; the keys smoke's key-only lesson shares the actor fix's key on purpose.
            if key in keys and not (lesson.id.startswith("actor-fix") and keys[key].startswith("actor-fix")):
                pytest.fail(f"{lesson.id} and {keys[key]} share key {key}")
            keys.setdefault(key, lesson.id)
    assert len(keys) >= 10



@pytest.mark.parametrize("task", CATALOG, ids=lambda task: task["id"])
def test_catalog_tasks_match_their_fixtures_and_keep_verifiers_hidden(task: dict) -> None:
    fixture = LIVE / task["fixture"]
    assert manifest_module.fixture_hash(fixture) == task["fixture_hash"]
    claude_live.refuse_project_settings(fixture)
    if task["verifier"] == "fake_answer_file":
        assert (fixture / "TASK.md").is_file()
        assert "42" not in (fixture / "TASK.md").read_text()
        return
    spec = verifier.lookup(task["verifier"])
    assert spec.hidden_layer == verifier.HIDDEN / task["id"]
    assert not (fixture / verifier.HIDDEN_TESTS).exists()
    corpus_support.assert_vitest_fixture(fixture, task["id"], trap=task["id"] in {"actor", "budget", "candidate", "slug"}, package_dir=verifier.TASK_PACKAGES[task["id"]], test_ext="ts" if task["id"] == "alias" else "mjs")


def test_the_catalog_covers_every_registered_task_and_ships_each_directory_once() -> None:
    assert {task["id"] for task in CATALOG} == set(verifier.TASK_PACKAGES) | {"answer-file"}
    assert {task["fixture"] for task in CATALOG} == {p.name for p in LIVE.iterdir() if p.is_dir() and p.name != "lessons"}
    assert sorted(p.parent.name for p in verifier.HIDDEN.glob(f"*/{images.QUIRK_CHECK}")) == ["ambient"]


def test_the_key_only_lesson_has_no_task_names_and_matches_the_actor_failure() -> None:
    lesson = tenjin_arm.lesson_named("actor-fix-keyonly")
    assert lesson is not None
    text = lesson.title + "\n" + lesson.body.read_text()
    assert all(word.lower() not in text.lower() for word in ("actor", "actorKey", "src/actor.mjs", "tests/actor.test.mjs"))
    assert lesson.keys == (actor_failure_key(),)


def test_actor_instructions_allow_recursive_experiments_without_loosening_network_scope():
    instructions = (ACTOR_FIXTURE / "CLAUDE.md").read_text()
    assert "do not spawn subagents" not in instructions
    assert "Network access is limited to configured Tenjin search/read/inspect commands" in instructions
    assert "Do not publish from the task container" in instructions
