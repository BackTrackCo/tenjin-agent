"""The live executor and the operator live command, proven without spending anything.

No case here starts `claude`. `NoProcess` replaces every process boundary this
package can reach, `runner.process_spawn`, `verifier.run`, and
`subprocess.Popen` itself, and the guard cases prove the replacement is the
object a real `Runtime` would call, so a case can never pass because a guard was
looking at a name nothing reads. A missing binary is never a silent skip: the
assertions are about the argv, the transcript directory, the environment, and
the refusals.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest import mock

import pytest

from evals.benchmark import (
    artifact,
    claude_live,
    claude_usage,
    cli,
    container,
    executor,
    images,
    manifest as manifest_module,
    records,
    runner,
    schedule,
    sha256_json,
    tenjin_arm,
    verifier,
)
from evals.benchmark.artifact import IsolationError
from evals.benchmark.claude_live import LiveExecutorError
from evals.benchmark import configuration, experiments, presets
from evals.benchmark.tests import support, corpus_support
from evals.benchmark.tests.support import ATTESTED

# The smoke manifest's own provider origin, which `SPEC.required_origins`
# makes the attestation state.
LIVE_ATTESTED = dataclasses.replace(ATTESTED, network_allowlist=("api.anthropic.com",), credential_seam="CLAUDE_CODE_OAUTH_TOKEN")
ATTESTATION_JSON = {
    "kind": "container",
    "instance_id": "bench1-smoke-01",
    "image": "ghcr.io/example/bench1@sha256:0000",
    "fresh_roots": True,
    "wallet_present": False,
    "credential_seam": "CLAUDE_CODE_OAUTH_TOKEN",
    "network_allowlist": ["api.anthropic.com"],
}
# A shell with the credential seam set, which `live-run` requires before spend.
LIVE_ENV = {"CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token"}
# What a seeded arm may run by hand, and the whole of it. Every seeded arm in
# every live manifest declares this same allowlist, so it is written once.
SEEDED_PERMISSIONS = {"allow": ["Bash(tenjin search:*)", "Bash(tenjin read:*)", "Bash(tenjin inspect:*)"]}

Request = Callable[..., executor.LaunchRequest]
Edited = Callable[..., executor.LaunchRequest]
AttestationFile = Callable[..., Path]



BENCH2 = {
    "actor": ("test-harness-convention", True, "", "mjs"),
    "budget": ("test-harness-convention", True, "", "mjs"),
    "candidate": ("test-harness-convention", True, "", "mjs"),
    "slug": ("test-harness-convention", True, "", "mjs"),
    "alias": ("vitest-path-alias", False, "", "ts"),
    "level": ("node-type-stripping", False, "", "mjs"),
    "money": ("esm-cjs-interop", False, "", "mjs"),
    "core": ("pnpm-workspace", False, "packages/core", "mjs"),
}


LESSON_PHRASES = ("pnpm test --", "pnpm exec", "vitest", "repository-specific", "truly targets", "wrong set", "tsconfig", "resolve.alias", "paths", "enum", "strip", "CommonJS", "default export", "--filter", "-C packages")


def assert_bench2_tasks(manifest: manifest_module.Manifest) -> None:
    assert [task["id"] for task in manifest.tasks] == ["actor", "alias", "core"]
    assert len({task["family"] for task in manifest.tasks}) == 3
    for task in manifest.tasks:
        family, trap, package_dir, ext = BENCH2[task["id"]]
        assert task["family"] == family
        assert task["transfer_distance"] == ("same_family" if trap else "same_task")
        fixture = manifest.fixture_path(task)
        claude_live.refuse_project_settings(fixture)
        spec = verifier.lookup(task["verifier"])
        assert (spec.hidden_layer / verifier.HIDDEN_TESTS / f"{task['id']}.test.mjs").is_file()
        assert not (fixture / verifier.HIDDEN_TESTS).exists()
        assert ("--package" in spec.argv(fixture)) == bool(package_dir)
        corpus_support.assert_vitest_fixture(fixture, task["id"], trap=trap, package_dir=package_dir, test_ext=ext)
        # The prompt states the goal and never the lesson.
        for phrase in LESSON_PHRASES:
            assert phrase.lower() not in task["prompt"].lower(), (task["id"], phrase)
        # Every task has its family lesson and its own fix lesson in the benchmark's words.
        lessons = tenjin_arm.lessons_for(task)
        assert [lesson.id for lesson in lessons] == [family, f"{task['id']}-fix"]


def test_the_real_manifest_is_the_phase_one_local_pilot() -> None:
    manifest = manifest_module.load(experiments.REAL_MANIFEST)
    trials = schedule.expand(manifest)
    assert (len(trials), manifest.data["repeats"], manifest.data["benchmark_version"]) == (6, 1, "bench2-local-preflight-2")
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_natural"]
    off, natural = manifest.arms
    assert (natural["provision"], natural["producer"], natural["auxiliary_usage"]) == ("tenjin", True, "exposed")
    assert "seed" not in natural
    assert manifest.slice is None
    hooks = hooks_smoke()
    assert off == hooks.arms[0]
    assert natural["settings"] == hooks.arms[1]["settings"]
    assert manifest.pins == {**hooks.pins, "concurrency": 1}
    assert manifest.pins["max_budget_usd"] == 0.75
    assert_bench2_tasks(manifest)


def test_the_core_suite_runs_the_five_arms_over_the_ten_tasks() -> None:
    manifest = manifest_module.load(experiments.LOCAL_ARMS_MANIFEST)
    trials = schedule.expand(manifest)
    assert len(trials) == 150
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert [arm["id"] for arm in manifest.arms] == ["off", "flat", "tenjin_seeded", "tenjin_seeded_no_public", "tenjin_natural"]
    off, flat, seeded, no_public, natural = manifest.arms
    # The two shelf arms differ in one value and nothing else, so any gap
    # between them is the marketplace leg and cannot be anything else.
    assert {**no_public, "id": seeded["id"], "public_fallback": "on"} == {**seeded, "public_fallback": "on"}
    assert (seeded.get("public_fallback"), no_public["public_fallback"]) == (None, "off")
    assert seeded["settings_hash"] == no_public["settings_hash"]
    # The seeded arm is the shelf arm exactly as the hooks smoke runs it: no local replay.
    assert (seeded["provision"], natural["producer"]) == ("tenjin", True)
    assert "seed" not in seeded
    assert seeded["settings"] == hooks_smoke().arms[1]["settings"]
    # The flat arm is the same lessons as static Markdown, through the foundation's overlay, hashed into its settings.
    assert sorted(flat["settings"]) == ["overlay"]
    assert sorted(flat["settings"]["overlay"]) == ["CLAUDE.md", "LESSONS.md"]
    assert flat["settings_hash"] == "sha256:" + sha256_json(flat["settings"])
    assert "provision" not in flat
    lessons = tenjin_arm.LESSONS
    expected = "\n\n".join((lessons / f"{name}.md").read_text(encoding="utf-8").rstrip("\n") for name in ("test-harness-convention", "actor-fix", "budget-fix", "candidate-fix", "slug-fix", "vitest-path-alias", "alias-fix", "node-type-stripping", "level-fix", "esm-cjs-interop", "money-fix", "pnpm-workspace", "core-fix")) + "\n"
    assert flat["settings"]["overlay"]["LESSONS.md"].endswith(expected)
    assert "read LESSONS.md" in flat["settings"]["overlay"]["CLAUDE.md"]
    claude_live._settings_overlay(flat["settings"]["overlay"])
    # The corpus is the phase-one pilot's, with the two high-discovery tasks
    # appended. The core suite selects from the corpus, it never invents a task.
    assert [task["id"] for task in manifest.tasks] == list(BENCH2) + list(HIGH_DISCOVERY)


def test_the_canary_manifest_is_two_same_task_transfers_off_against_the_shelf_arm() -> None:
    """The PR/main health lane: two families, one attempt per task and arm."""
    manifest = manifest_module.load(experiments.CANARY_MANIFEST)
    core = manifest_module.load(experiments.LOCAL_ARMS_MANIFEST)
    trials = schedule.expand(manifest)
    assert (len(trials), manifest.data["benchmark_version"]) == (4, "bench2-canary-3")
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_seeded"]
    assert [task["id"] for task in manifest.tasks] == ["alias", "core"]
    # Every task is a same-task transfer, and no two share a lesson family,
    # so four attempts cover two transfer families.
    assert {task["transfer_distance"] for task in manifest.tasks} == {"same_task"}
    assert len({task["family"] for task in manifest.tasks}) == len(manifest.tasks)
    # The canary is a subset of the core suite, never a second definition of it.
    assert manifest.arms == [arm for arm in core.arms if arm["id"] in ("off", "tenjin_seeded")]
    assert manifest.tasks == [task for task in core.tasks if task["id"] in ("alias", "core")]
    # The caps are the only pins the canary and the core suite differ on: the
    # core suite raised them for the two high-discovery tasks. The canary
    # retains its existing caps; records from these protocols never pool.
    assert manifest.pins == {**core.pins, "wall_clock_s": 600, "turn_budget": 40, "max_budget_usd": 0.75, "concurrency": 1}


def test_the_high_discovery_manifest_is_the_two_task_pilot_with_the_caps_raised() -> None:
    """The pilot of `tenjin-notes` plans/2026-09-10: two shapes designed for round trips, on their own manifest."""
    manifest = manifest_module.load(experiments.HIGH_DISCOVERY_MANIFEST)
    canary = manifest_module.load(experiments.CANARY_MANIFEST)
    trials = schedule.expand(manifest)
    assert len(trials) == 12
    assert manifest.data["benchmark_version"] == manifest_module.load(experiments.LOCAL_ARMS_MANIFEST).data["benchmark_version"]
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_seeded"]
    # The arms are the canary's, unedited: the treatment is the same and the tasks are what changed.
    assert manifest.arms == canary.arms
    assert [task["id"] for task in manifest.tasks] == list(HIGH_DISCOVERY)
    # Only the caps differ from the canary's pins, and each is raised. A
    # capped attempt is not rejected by this harness, it is truncated, and
    # it is the baseline arm that does the extra work, so a ceiling sized
    # for 7.5 requests would censor the quantity these tasks exist to move.
    raised = {"wall_clock_s": 1500, "turn_budget": 80, "max_budget_usd": 2.50}
    assert manifest.pins == {**canary.pins, **raised, "concurrency": 3}
    for key, value in raised.items():
        assert value > canary.pins[key]
    for task in manifest.tasks:
        family, source = HIGH_DISCOVERY[task["id"]]
        assert (task["family"], task["transfer_distance"]) == (family, "same_task")
        assert verifier.TASK_SOURCES[task["id"]] == source
        fixture = manifest.fixture_path(task)
        claude_live.refuse_project_settings(fixture)
        spec = verifier.lookup(task["verifier"])
        assert (spec.hidden_layer / verifier.HIDDEN_TESTS / f"{task['id']}.test.mjs").is_file()
        assert not (fixture / verifier.HIDDEN_TESTS).exists()
        corpus_support.assert_vitest_fixture(fixture, task["id"], trap=False)
        for phrase in LESSON_PHRASES + HIGH_DISCOVERY_PHRASES:
            assert phrase.lower() not in task["prompt"].lower(), (task["id"], phrase)
        # One lesson each, the mechanism, and no `<task>-fix` beside it:
        # what each fixture still gets wrong lives only in the injected
        # cases, so a fix lesson would be the answer rather than the way in.
        assert [lesson.id for lesson in tenjin_arm.lessons_for(task)] == [family]
        assert tenjin_arm.lesson_named(f"{task['id']}-fix") is None


def test_the_pilot_tasks_are_additions_and_the_control_corpus_is_untouched() -> None:
    """The four convention tasks stay: without the low-discovery end of the range a ratio cannot be read against cost."""
    core = manifest_module.load(experiments.LOCAL_ARMS_MANIFEST)
    pilot = manifest_module.load(experiments.HIGH_DISCOVERY_MANIFEST)
    pilot_ids = [task["id"] for task in pilot.tasks]
    # The pilot graduated into the core suite: the two tasks are appended to the
    # eight, never substituted for any of them, and the caps came with them, so
    # the core suite now runs the pilot's environment over the whole corpus.
    assert [task["id"] for task in core.tasks] == list(BENCH2) + pilot_ids
    assert set(pilot_ids) & set(BENCH2) == set()
    assert core.pins == pilot.pins


@pytest.mark.parametrize(
    "path",
    experiments.MANIFESTS,
    ids=lambda path: path.name,
)
def test_every_real_task_manifest_resets_the_bench_corpus_and_names_no_other_shelf(path: Path) -> None:
    """The one knob is `--tenjin-source`; this is what stops a manifest drifting off the bench shelf."""
    corpus = manifest_module.load(path).corpus
    assert corpus is not None, f"{path.name} names no corpus, so a run would measure whatever else is on the shelf"
    assert (corpus.provider, corpus.origin) == ("neon", "bench.tenjin.sh")
    assert corpus.branch_id == "br-ancient-dream-ave43t84"
    assert corpus.parent_id == "br-shiny-mountain-av1jfsuq"
    assert corpus.branch_id != corpus.parent_id


@pytest.mark.parametrize("path", list(experiments.SLICE_MANIFESTS.values()), ids=list(experiments.SLICE_MANIFESTS))
def test_the_slice_manifests_state_one_variation_each(path: Path) -> None:
    pilot = manifest_module.load(experiments.REAL_MANIFEST)
    manifest = manifest_module.load(path)
    trials = schedule.expand(manifest)
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert manifest.pins == pilot.pins
    assert manifest.slice["kind"] == "recursive"
    assert len(trials) == 12
    (task,) = manifest.tasks
    assert task["id"] == "actor"
    assert "Agent" in task["tools"]
    assert "Agent" in task["allowed_tools"]
    assert "subagent" in task["prompt"]
    assert task["required_descendants"] == 1
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_seeded", "tenjin_seeded_no_public", "tenjin_natural"]
    for arm in manifest.arms[1:]:
        assert arm["lessons"] == ["test-harness-convention", "actor-fix"]
    # The other manifests never hand a task the subagent tool.
    assert all("tools" not in task for task in pilot.tasks)



@pytest.mark.parametrize("path", experiments.MANIFESTS, ids=lambda path: path.name)
def test_experiment_settings_expand_to_the_declared_treatment(path: Path) -> None:
    for arm in manifest_module.load(path).arms:
        assert arm["settings_hash"] == "sha256:" + sha256_json(arm["settings"])


def test_every_experiment_selects_only_shared_catalog_fixtures() -> None:
    catalog = {task["id"]: task for task in json.loads((cli.FIXTURES / "live" / "catalog.json").read_text())["tasks"]}
    for path in experiments.MANIFESTS:
        for task in manifest_module.load(path).tasks:
            assert task["id"] in catalog
            assert task["fixture"] == catalog[task["id"]]["fixture"]
            assert task["fixture_hash"] == catalog[task["id"]]["fixture_hash"]
            assert task["verifier"] == catalog[task["id"]]["verifier"]


HIGH_DISCOVERY = {
    "shadow": ("stale-build-artifact", "packages/range/src/range.mjs"),
    "ambient": ("invisible-whitespace-mismatch", "src/price.mjs"),
}


def hooks_smoke() -> manifest_module.Manifest:
    return manifest_module.load(configuration.HOOKS_SMOKE_MANIFEST)


HIGH_DISCOVERY_PHRASES = ("dist", "built", "build", "artifact", "rebuild", "code point", "no-break", "U+00A0", "Intl", "separator", "locale", "whitespace", "invisible")


def test_diagnostic_selections_inherit_core_without_copied_definitions() -> None:
    core = manifest_module.load(experiments.LOCAL_ARMS_MANIFEST)
    for path, task_ids in ((experiments.CORPUS_MANIFEST, [task["id"] for task in core.tasks]),
                           (experiments.HIGH_DISCOVERY_MANIFEST, ["shadow", "ambient"])):
        source = json.loads(path.read_text())
        assert source["source"] == experiments.LOCAL_ARMS_MANIFEST.name
        assert "pins" not in source
        selected = manifest_module.load(path)
        assert selected.tasks == [task for task in core.tasks if task["id"] in task_ids]
        assert selected.arms == [arm for arm in core.arms if arm["id"] in ("off", "tenjin_seeded")]
        assert selected.pins == core.pins
        assert selected.data["repeats"] == core.data["repeats"]


@pytest.mark.parametrize("path", experiments.CODEX_MANIFESTS, ids=lambda path: path.name)
def test_codex_selections_keep_the_same_corpus_and_treatments(path):
    selection = json.loads(path.read_text())
    original = manifest_module.load(path.parent / selection["source"])
    matched = manifest_module.load(path)
    assert matched.tasks == original.tasks
    assert [{**arm, "executor": "codex_live"} for arm in original.arms] == matched.arms
    assert matched.pins["model"] == "gpt-5.6-sol"
    assert matched.pins["billing_mode"] == "subscription"
    assert matched.pins["speed_mode"] == "fast"
