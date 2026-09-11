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
from evals.benchmark import configuration
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


from evals.benchmark import cases, signature, presets

def smoke() -> manifest_module.Manifest:
    return manifest_module.load(configuration.SMOKE_MANIFEST)


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    return tmp_path / "run"


@pytest.fixture
def request_for(run_dir: Path) -> Request:
    def build(manifest: manifest_module.Manifest, index: int = 0) -> executor.LaunchRequest:
        trial = schedule.expand(manifest)[index]
        task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
        arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
        roots = artifact.create(run_dir, trial.trial_id, manifest.fixture_path(task))
        return executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins)

    return build


def hooks_smoke() -> manifest_module.Manifest:
    return manifest_module.load(configuration.HOOKS_SMOKE_MANIFEST)


def test_the_hooks_smoke_manifest_is_the_installed_hook_set_as_a_template() -> None:
    manifest = hooks_smoke()
    assert len(schedule.expand(manifest)) == len(manifest.tasks) * len(manifest.arms) * manifest.data["repeats"]
    arm = next(arm for arm in manifest.arms if arm["id"] == "tenjin_seeded")
    assert arm["provision"] == "tenjin"
    handlers = [handler for entries in arm["settings"]["hooks"].values() for entry in entries for handler in entry["hooks"]]
    http = [handler for handler in handlers if handler["type"] == "http"]
    # The shape rather than the tally: adding a hook to the installed set is
    # not a regression, and every http one addressing the trial's own daemon is.
    assert {handler["type"] for handler in handlers} == {"http", "command"}
    assert http and len(http) < len(handlers)
    assert {handler["url"] for handler in http} == {"{daemon_url}"}
    assert claude_live.placeholders_of(arm["settings"]) == {"daemon_url", "daemon_token", "data_dir"}
    assert "PostToolUseFailure" in arm["settings"]["hooks"]
    # The seeded arm may read the shelf by hand; the pins, and so the off arm, are unchanged.
    assert arm["settings"]["permissions"] == SEEDED_PERMISSIONS
    assert "permissions" not in next(other for other in manifest.arms if other["id"] == "off")["settings"]
    assert "SubagentStart" in arm["settings"]["hooks"]
    # The declared hash names the template: a fragment that does not hash to it is refused.
    claude_live.settings_of(arm, manifest.pins)
    with pytest.raises(LiveExecutorError):
        claude_live.settings_of({**arm, "settings_hash": "sha256:" + "0" * 64}, manifest.pins)
    # The pin no longer encodes the lesson: every rule opens a whole binary
    # rather than one command line, so the wrong commands fail inside the
    # repository and not at the permission gate. The rule shape rather than
    # the roster, because allowing another binary is not a regression.
    bash = [rule for rule in manifest.pins["allowed_tools"] if rule.startswith("Bash(")]
    assert bash and all(re.fullmatch(r"Bash\([a-z0-9_-]+:\*\)", rule) for rule in bash)
    assert "WebFetch" not in manifest.pins["tools"]
    for task in manifest.tasks:
        claude_live.refuse_project_settings(manifest.fixture_path(task))
        assert verifier.lookup(task["verifier"]).hidden_layer == verifier.HIDDEN / task["id"]
        corpus_support.assert_vitest_fixture(manifest.fixture_path(task), task["id"])
        # The prompt states the task and never the lesson.
        for phrase in ("pnpm test --", "pnpm exec", "vitest", "wrong set"):
            assert phrase not in task["prompt"]


def test_the_keys_smoke_arms_seed_the_key_only_lesson_and_the_reporter_arm_overlays_the_config(request_for: Request, run_dir: Path) -> None:
    manifest = manifest_module.load(configuration.KEYS_SMOKE_MANIFEST)
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_keyed_console", "tenjin_keyed_reporter"]
    assert len(schedule.expand(manifest)) == len(manifest.tasks) * len(manifest.arms) * manifest.data["repeats"]
    console, reporter = manifest.arms[1], manifest.arms[2]
    assert (console["lessons"], reporter["lessons"]) == (["actor-fix-keyonly"], ["actor-fix-keyonly"])
    assert "overlay" not in console["settings"]
    overlay = reporter["settings"]["overlay"]
    assert list(overlay) == ["vitest.config.mjs"]
    assert "['{data_dir}/hooks/tenjin-vitest-reporter.mjs', { outputFile: '.vitest-report.json' }]" in overlay["vitest.config.mjs"]
    assert corpus_support.PNPM_GUARD in overlay["vitest.config.mjs"]
    for arm in (console, reporter):
        claude_live.settings_of(arm, manifest.pins)
        with pytest.raises(LiveExecutorError):
            claude_live.settings_of({**arm, "settings": {**arm["settings"], "env": {"X": "1"}}}, manifest.pins)
        assert arm["settings"]["permissions"] == SEEDED_PERMISSIONS
    assert manifest.arms[0] == next(arm for arm in hooks_smoke().arms if arm["id"] == "off")
    # The overlay lands in the trial copy with the data dir resolved, and never in the child's settings file.
    index = next(index for index, trial in enumerate(schedule.expand(manifest)) if trial.arm_id == "tenjin_keyed_reporter")
    provision = executor.Provision(values={"daemon_url": "http://127.0.0.1:1/hook/claude", "daemon_token": "t", "data_dir": str(run_dir / "d")})
    request = dataclasses.replace(request_for(manifest, index), provision=provision, dry_run=True)
    launch = claude_live.launch(request)
    written = (request.roots.repo / "vitest.config.mjs").read_text(encoding="utf-8")
    assert f"['{request.roots.data_dir}/hooks/tenjin-vitest-reporter.mjs', {{ outputFile: '.vitest-report.json' }}]" in written
    assert "{data_dir}" not in written
    assert "overlay" not in json.loads(claude_live.settings_path(request.roots).read_text(encoding="utf-8"))
    assert launch.resolved_settings_hash is not None
    assert launch.resolved_settings_hash != reporter["settings_hash"]
    # The product's config regex (test-identity.ts) finds the reporter and its output file in the overlaid config.
    assert re.search(r"reporters\s*:[\s\S]{0,600}?['\"][^'\"]*tenjin-vitest-reporter[^'\"]*['\"][\s\S]{0,300}?outputFile\s*:\s*['\"]\.vitest-report\.json['\"]", written)


def test_the_smoke_manifest_validates_and_expands_to_a_balanced_schedule() -> None:
    manifest = smoke()
    trials = schedule.expand(manifest)
    assert len(trials) == len(manifest.tasks) * len(manifest.arms) * manifest.data["repeats"]
    # Gate 3 is four to eight attempts, and this manifest sits at the floor on purpose.
    assert 4 <= len(trials) <= 8
    assert {trial.arm_id for trial in trials} == {arm["id"] for arm in manifest.arms}
    schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
    assert all(executor.lookup(arm["executor"]).live for arm in manifest.arms)


def test_the_smoke_fixture_carries_no_verifier_bytes_and_no_project_settings() -> None:
    manifest = smoke()
    task = manifest.tasks[0]
    fixture = manifest.fixture_path(task)
    # The expected answer is in the prompt on purpose: this smoke measures
    # plumbing, not difficulty. What must stay off the agent's mount is the
    # verifier, which lives in `verifier.py` and mounts no hidden layer.
    assert sorted(path.name for path in fixture.iterdir()) == ["TASK.md"]
    assert verifier.lookup(task["verifier"]).hidden_layer is None
    claude_live.refuse_project_settings(fixture)


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


def test_the_key_only_lesson_shares_no_file_name_with_the_prompt() -> None:
    live = tenjin_arm.FIXTURES / "live" / "lessons"
    lesson = tenjin_arm.lesson_named("actor-fix-keyonly", live)
    assert lesson is not None
    prompt = next(task for task in json.loads(configuration.KEYS_SMOKE_MANIFEST.read_text(encoding="utf-8"))["tasks"])["prompt"]
    text = lesson.title + "\n" + lesson.body.read_text(encoding="utf-8")
    assert cases.shared_file_names(prompt, text) == []
    for word in ("actor", "actorKey", "src/actor.mjs", "tests/actor.test.mjs"):
        assert word.lower() not in text.lower()
    assert lesson.keys == (actor_failure_key(),)
    assert cases.shared_file_names(prompt, "edit src/actor.mjs") == ["actor", "actor.mjs"]



@pytest.mark.parametrize("path", configuration.MANIFESTS, ids=lambda path: path.name)
def test_framework_smoke_settings_hash_the_expanded_treatment(path: Path) -> None:
    for arm in manifest_module.load(path).arms:
        assert arm["settings_hash"] == "sha256:" + sha256_json(arm["settings"])


def test_named_product_hook_preset_preserves_the_installed_template() -> None:
    expected = "sha256:e88581553afac93ea55d673f06ec0cfb7ec91dfc94639352d1c20af5ae64bbbf"
    assert "sha256:" + sha256_json(presets.settings(presets.TENJIN_HOOKS_AND_CLI_READS)) == expected
