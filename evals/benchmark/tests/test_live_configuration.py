"""The shipped Bench-1 run selections and corpus wiring, with no model launched."""
from __future__ import annotations

import dataclasses
import io
import json
import re
import subprocess
from pathlib import Path
from unittest import mock

import pytest

from evals.benchmark import FIXTURES, REPO_ROOT, cases, claude_live, cli, executor, manifest as manifest_module, regress, schedule, tenjin_arm, toolchain, vendor, verifier
from evals.benchmark.claude_live import LiveExecutorError
from evals.benchmark.tests import support
from evals.benchmark.tests.corpus_support import actor_failure_key
from evals.benchmark.tests.test_claude_live import Request, SEEDED_PERMISSIONS, request_for, run_dir, trial_toolchain
from evals.benchmark.tests.test_tenjin_arm import SECRET, WriteSource, write_source

SMOKE_MANIFEST = FIXTURES / "live" / "smoke-manifest.json"
HOOKS_SMOKE_MANIFEST = FIXTURES / "live" / "hooks-smoke-manifest.json"
KEYS_SMOKE_MANIFEST = FIXTURES / "live" / "keys-smoke-manifest.json"
BASELINE = FIXTURES / "live" / "baseline.json"


def smoke() -> manifest_module.Manifest:
    return manifest_module.load(SMOKE_MANIFEST)


def hooks_smoke() -> manifest_module.Manifest:
    return manifest_module.load(HOOKS_SMOKE_MANIFEST)


def test_the_key_only_lesson_shares_no_file_name_with_the_prompt() -> None:
    live = tenjin_arm.FIXTURES / "live" / "lessons"
    lesson = tenjin_arm.lesson_named("actor-fix-keyonly", live)
    assert lesson is not None
    prompt = next(task for task in json.loads(KEYS_SMOKE_MANIFEST.read_text(encoding="utf-8"))["tasks"])["prompt"]
    text = lesson.title + "\n" + lesson.body.read_text(encoding="utf-8")
    assert cases.shared_file_names(prompt, text) == []
    for word in ("actor", "actorKey", "src/actor.mjs", "tests/actor.test.mjs"):
        assert word.lower() not in text.lower()
    assert lesson.keys == (actor_failure_key(),)
    assert cases.shared_file_names(prompt, "edit src/actor.mjs") == ["actor", "actor.mjs"]


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
        vendored = manifest.vendor_for(task)
        assert vendored is not None
        support.assert_vitest_fixture(manifest.fixture_path(task), task["id"], vendored)
        # The prompt states the task and never the lesson.
        for phrase in ("pnpm test --", "pnpm exec", "vitest", "wrong set"):
            assert phrase not in task["prompt"]


def test_the_keys_smoke_arms_seed_the_key_only_lesson_and_the_reporter_arm_overlays_the_config(request_for: Request, run_dir: Path) -> None:
    manifest = manifest_module.load(KEYS_SMOKE_MANIFEST)
    assert [arm["id"] for arm in manifest.arms] == ["off", "tenjin_keyed_console", "tenjin_keyed_reporter"]
    assert len(schedule.expand(manifest)) == len(manifest.tasks) * len(manifest.arms) * manifest.data["repeats"]
    console, reporter = manifest.arms[1], manifest.arms[2]
    assert (console["lessons"], reporter["lessons"]) == (["actor-fix-keyonly"], ["actor-fix-keyonly"])
    assert "overlay" not in console["settings"]
    overlay = reporter["settings"]["overlay"]
    assert list(overlay) == ["vitest.config.mjs"]
    assert "['{data_dir}/hooks/tenjin-vitest-reporter.mjs', { outputFile: '.vitest-report.json' }]" in overlay["vitest.config.mjs"]
    assert support.PNPM_GUARD in overlay["vitest.config.mjs"]
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


def test_the_launch_injects_the_hidden_cases_as_a_setup_file_the_fixture_never_holds(request_for: Request) -> None:
    manifest = hooks_smoke()
    index = next(index for index, trial in enumerate(schedule.expand(manifest)) if trial.arm_id == "off")
    request = dataclasses.replace(request_for(manifest, index), dry_run=True)
    fixture = manifest.fixture_path(request.task)
    assert not (fixture / ".bench1").exists()
    assert not (request.roots.repo / ".bench1").exists()
    claude_live.launch(request)
    setup = (request.roots.repo / ".bench1" / "cases.setup.mjs").read_text(encoding="utf-8")
    assert "globalThis.__bench1Cases = " in setup
    hidden = json.loads((verifier.HIDDEN / "actor" / "cases.json").read_text(encoding="utf-8"))
    assert json.dumps({"actor": hidden}) in setup
    # The fixture's config names the setup file, so the run reads it; nothing under the fixture names the value.
    assert "setupFiles: ['./.bench1/cases.setup.mjs']" in (fixture / "vitest.config.mjs").read_text(encoding="utf-8")
    assert claude_live.inject_cases(request.roots, {"id": "answer-file"}) is None


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


def test_the_live_manifests_name_the_one_archive_and_its_record_agrees_with_the_fixture() -> None:
    manifest = manifest_module.load(HOOKS_SMOKE_MANIFEST)
    assert len({task["vendor"] for task in manifest.tasks}) == 1
    built = manifest.vendor_for(manifest.tasks[0])
    assert built is not None
    assert built.archive.parent.name == vendor.DIR
    assert built.record["platform"] == "darwin-arm64"
    assert built.record["node_abi"] == "137"
    for task in manifest.tasks:
        path = manifest.fixture_path(task)
        assert built.record["lock_sha256"] == "sha256:" + vendor.sha256_file(path / "pnpm-lock.yaml")
        assert [item.name for item in (path / "node_modules").iterdir()] == [".bin"]
    smoke = manifest_module.load(SMOKE_MANIFEST)
    assert smoke.vendor_for(smoke.tasks[0]) is None


def test_the_vendor_directory_keeps_the_record_and_the_archive_comes_from_a_release_asset() -> None:
    """7.4 MB of build output in a squashed commit is in `main` for good, so the tree keeps the pin alone."""
    manifest = manifest_module.load(HOOKS_SMOKE_MANIFEST)
    built = manifest.vendor_for(manifest.tasks[0])
    assert built is not None
    # Nothing but the record and, on a machine that has fetched, the archive itself.
    assert sorted(path.name for path in built.archive.parent.iterdir()) in ([built.path.name], sorted([built.path.name, built.archive.name]))
    # The line that keeps a fetched archive out of the next commit.
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert f"evals/benchmark/fixtures/live/{vendor.DIR}/*{vendor.SUFFIX}" in ignored
    assert vendor.archive_url(built, {}) == (
        "https://github.com/BackTrackCo/tenjin-agent/releases/download/"
        "bench-vendor-vitest-3.2.4-node24-darwin-arm64/vitest-3.2.4-node24-darwin-arm64.tar.gz"
    )


def test_the_real_archive_holds_the_vitest_its_record_names() -> None:
    """The one case that reads the released bytes: a record could otherwise name a vitest the archive does not hold."""
    manifest = manifest_module.load(HOOKS_SMOKE_MANIFEST)
    built = manifest.vendor_for(manifest.tasks[0])
    assert built is not None
    if not built.archive.is_file():
        pytest.skip(f"the vendored archive is not in this checkout: {vendor.fetch_hint(built)}")
    assert vendor.check_archive(built) == built.record["archive_sha256"]
    assert built.archive.stat().st_size < 10 << 20
    installed = json.loads(vendor.read_member(built, "vitest/package.json").decode("utf-8"))
    pinned = json.loads((manifest.fixture_path(manifest.tasks[0]) / "package.json").read_text(encoding="utf-8"))["devDependencies"]["vitest"]
    assert (installed["version"], built.record["vitest"]) == (pinned, pinned)


def test_every_live_fixture_pins_the_validated_pnpm() -> None:
    manifest = manifest_module.load(HOOKS_SMOKE_MANIFEST)
    for task in manifest.tasks:
        assert toolchain.package_manager_pin(manifest.fixture_path(task)) == "11.11.0"
    smoke = manifest_module.load(SMOKE_MANIFEST)
    assert toolchain.package_manager_pin(smoke.fixture_path(smoke.tasks[0])) is None


def test_the_committed_baseline_loads() -> None:
    data = regress.load_baseline(BASELINE)
    assert set(data["arms"]) == {"off", "on"}
    assert "non-publishable" in data["source"]


def test_the_dry_run_resolves_the_hooks_and_prints_no_token_and_no_secret(write_source: WriteSource, run_dir: Path) -> None:
    stream = io.StringIO()
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        payload = cli.live_run(run_dir, HOOKS_SMOKE_MANIFEST, dry_run=True, stream=stream, environ={}, tenjin_source=write_source())
    printed = stream.getvalue()
    installed = manifest_module.load(HOOKS_SMOKE_MANIFEST)
    trials = schedule.expand(installed)
    handlers = [
        handler
        for arm in installed.arms
        if arm["id"] == "tenjin_seeded"
        for entries in arm["settings"]["hooks"].values()
        for entry in entries
        for handler in entry["hooks"]
    ]
    assert len(payload["trials"]) == len(trials)
    seeded = [plan for plan in payload["trials"] if plan["arm_id"] == "tenjin_seeded"]
    assert len(seeded) == len([trial for trial in trials if trial.arm_id == "tenjin_seeded"])
    for plan in seeded:
        assert plan["provision"]["shelf_secret_present"] is True
        # One resolved line per installed handler: the whole set, never a subset.
        assert len(plan["hooks"]) == len(handlers)
        assert any(hook.startswith("SubagentStart http http://127.0.0.1:0/hook/claude headers=Authorization") for hook in plan["hooks"])
        assert any("tenjin-shim.mjs" in hook and hook.startswith("SessionStart command") for hook in plan["hooks"])
    assert "shelf_secret_present=true shelf_origin=team-shelf.example" in printed
    # The vendored toolchain is named, with the host verdict, and nothing was extracted.
    assert "vendor    vitest-3.2.4-node24-darwin-arm64 platform=darwin-arm64 node_abi=137 host=" in printed
    assert ("extracted into repo/node_modules" if vendor.host_platform() == "darwin-arm64" else "MISMATCH") in printed
    # The archive is a release asset, so the line states whether this checkout has it.
    assert ("live-run fetches it first" in printed) is not payload["trials"][0]["vendor"]["present"]
    for plan in payload["trials"]:
        assert plan["vendor"]["id"] == "vitest-3.2.4-node24-darwin-arm64"
        assert plan["vendor"]["present"] is installed.vendor_for(installed.tasks[0]).archive.is_file()
        assert not (Path(plan["roots"]["cwd"]) / "node_modules" / "vitest").exists()
    assert SECRET not in printed
    assert tenjin_arm.DRY_TOKEN not in printed
    for plan in payload["trials"]:
        if plan["arm_id"] == "off":
            assert plan["hooks"] == []
            assert plan["provision"] is None
