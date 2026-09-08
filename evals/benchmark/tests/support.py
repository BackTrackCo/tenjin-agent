"""Shared fixture helpers for the offline benchmark self-test."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any, Callable

from evals.benchmark import (
    FIXTURES,
    REPO_ROOT,
    artifact,
    claude_usage,
    executor,
    manifest as manifest_module,
    records,
    runner,
    schedule,
    sha256_file,
    sha256_json,
    vendor,
)

SESSIONS = FIXTURES / "claude" / "sessions"
TRIAL = "trial-fixture"
STORE = REPO_ROOT / "src" / "hooks" / "store.ts"

Edit = Callable[[list[Any]], list[Any]]
Before = Callable[[executor.Launch, artifact.TrialRoots], None]

ATTESTED = artifact.Attestation(
    kind="container",
    instance_id="bench1-abc123",
    image="ghcr.io/example/bench1@sha256:0000",
    fresh_roots=True,
    wallet_present=False,
    credential_seam="env_injection",
    network_allowlist=("api.provider.example", "shelf.example"),
)


class FakeClock:
    """An injected clock and barrier: tests advance time, never wait for it."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def synthetic_manifest(
    tmp: Path,
    *,
    tasks: int = 1,
    arms: tuple[str, ...] = ("off", "on"),
    repeats: int = 1,
    seed: int = 1,
    executor_name: str = "fake",
    verifier_name: str = "fake_answer_file",
    wall_clock_s: int = 30,
    auxiliary_usage: str = "none",
    live: bool = False,
    prompt: str = "Write 42 into answer.txt.",
) -> manifest_module.Manifest:
    """A manifest object for runner and schedule cases, with a disposable fixture.

    `manifest.load` and its validation have their own cases; building the
    object here keeps an execution case from also being a manifest case.
    `live=True` adds the fields a live executor needs and nothing else, so a
    fake case and a live case differ by exactly those fields.
    """
    fixture = tmp / "fixture"
    fixture.mkdir(parents=True, exist_ok=True)
    (fixture / "TASK.md").write_text("Write 42 into answer.txt.\n", encoding="utf-8")
    data: dict[str, Any] = {
        "benchmark_version": "bench1-test-0",
        "schema_version": manifest_module.SCHEMA_VERSION,
        "harness": "claude",
        "seed": seed,
        "repeats": repeats,
        "pins": {
            "model": "fake-model-0",
            "harness_version": "0.0.0",
            "effort": "default",
            "image": "none",
            "dependency_lock_hash": "sha256:none",
            "permission_mode": "default",
            "wall_clock_s": wall_clock_s,
            "turn_budget": 4,
        },
        "price_sheet_version": "fake-2026-09",
        "tasks": [
            {
                "id": f"task-{index}",
                "family": "fake",
                "transfer_distance": "none",
                "fixture": "fixture",
                "fixture_hash": manifest_module.fixture_hash(fixture),
                "verifier": verifier_name,
                **({"prompt": prompt} if live else {}),
            }
            for index in range(tasks)
        ],
        "arms": [
            {
                "id": arm,
                "executor": executor_name,
                "product_version": "none",
                "settings_hash": f"sha256:{arm}",
                "memory_snapshot_hash": "sha256:empty",
                "auxiliary_usage": auxiliary_usage,
            }
            for arm in arms
        ],
    }
    if live:
        data["pins"].update(
            {
                "permission_mode": "dontAsk",
                "max_budget_usd": 0.25,
                "credential_env": "ANTHROPIC_API_KEY",
                "tools": ["Read", "Write"],
                "allowed_tools": ["Read(./**)", "Write(./**)"],
            }
        )
        for arm in data["arms"]:
            arm["settings"] = {"env": {"BENCH_ARM": arm["id"]}}
            arm["settings_hash"] = "sha256:" + sha256_json(arm["settings"])
    path = tmp / "manifest.json"
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return manifest_module.Manifest(data=data, path=path, hash=sha256_json(data))


def fake_spawn(
    *,
    answer: str = "42\n",
    child: bool = True,
    grandchild: bool = False,
    settled: bool = True,
    returncode: int = 0,
    before: Before | None = None,
    after: Before | None = None,
) -> runner.Spawn:
    """An in-process stand-in for the executor: writes what an agent would leave.

    Only the process-group case needs a real process; every other execution
    case injects this so the suite spends no real time. `after` runs once the
    transcripts exist, which is where a case rewrites them into the shape a
    broken harness would leave behind.
    """

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        if before is not None:
            before(launch, roots)
        executor.write_transcripts(
            roots.output,
            launch.root_session_id,
            launch.root_session_id,
            "off",
            child=child,
            grandchild=grandchild,
            settled=settled,
        )
        if answer:
            (roots.repo / "answer.txt").write_text(answer, encoding="utf-8")
        if after is not None:
            after(launch, roots)
        return runner.Completed(returncode=returncode, stderr="", timed_out=False)

    return spawn


def loop_ddl() -> str:
    """The product's own DDL, so the fixture cannot drift from src/hooks/store.ts."""
    match = re.search(r"export const LOOP_DDL = `([\s\S]*?)`;", STORE.read_text(encoding="utf-8"))
    assert match is not None, "LOOP_DDL not found in store.ts"
    return match.group(1)


def write_loop_db(path: Path, fires: list[tuple[str, str, str]]) -> None:
    """A settled loop.db carrying one prompt fire per (id, session, agent)."""
    db = sqlite3.connect(path)
    try:
        db.executescript(loop_ddl())
        for index, (fire_id, session, agent) in enumerate(fires, start=1):
            db.execute(
                "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, reason, delivered,"
                " cwd, wait, deadline_ms, elapsed_ms, question)"
                " VALUES (?, ?, ?, ?, 'prompt', 'claude', 'prompt', ?, 'hit', 'team:piece-1',"
                " '/private/host/path', 'sync', 1000, 12, 'private question text')",
                (fire_id, index, session, agent, f"p{index}"),
            )
        db.commit()
    finally:
        db.close()


def arm_entries(**exposure: str) -> list[dict[str, Any]]:
    """Manifest arm entries keyed by id, one per declared auxiliary exposure."""
    return [
        {
            "id": arm_id,
            "executor": "fake",
            "product_version": "none",
            "settings_hash": f"sha256:{arm_id}",
            "memory_snapshot_hash": "sha256:empty",
            "auxiliary_usage": value,
        }
        for arm_id, value in exposure.items()
    ]


REDUCE_MANIFEST_HASH = "sha256:reduce"
REDUCE_SCHEDULE_HASH = "sha256:reduce-schedule"


def reduction_record(
    task_id: str,
    arm_id: str,
    repeat: int,
    position: int,
    tokens: int,
    outcome: str = "pass",
    *,
    reasoning: int | None = None,
    auxiliary: tuple[dict[str, Any], ...] = (),
    reconciliation: str = "matched",
    deliveries: int = 0,
    manifest_hash: str = REDUCE_MANIFEST_HASH,
) -> dict[str, Any]:
    """A valid attempt record with exactly the token total a reducer case needs.

    The reducer cases are about arithmetic and weighting, so this builds the
    record directly rather than parsing a session; the parse path has its own
    cases in `test_claude_usage.py`.
    """
    trial = schedule.trial_id(manifest_hash, task_id, arm_id, repeat, position)
    session = f"fake-{trial}"
    lead = ["claude", session, ""]
    input_total = tokens * 2 // 3
    usage = [
        {
            "adapter": "claude",
            "adapter_version": "1",
            "trial_id": trial,
            "actor_key": lead,
            "native_request_id": "req_1",
            "input_total": input_total,
            "uncached_input": None,
            "cache_read": None,
            "cache_write": None,
            "output_total": tokens - input_total,
            "reasoning_output_subset": reasoning,
            "provider_total": None,
            "native_request_cost": None,
            "completion_state": "complete" if outcome in ("pass", "fail") else "partial",
            "source_hash": "sha256:source",
        }
    ]
    fires = [
        {
            "fire_id": f"fire-{index}",
            "actor": lead,
            "at": 1757000000 + index,
            "event": "prompt",
            "hook_arm": "kernel",
            "prompt_id": f"p-{index}",
            "reason": "hit",
            "delivered": "piece_a1b2c3",
        }
        for index in range(deliveries)
    ]
    return {
        "schema": records.RECORD_SCHEMA,
        "trial_id": trial,
        "manifest_hash": manifest_hash,
        "schedule_hash": REDUCE_SCHEDULE_HASH,
        "task_id": task_id,
        "arm_id": arm_id,
        "repeat": repeat,
        "position": position,
        "settings_hash": f"sha256:{arm_id}",
        "environment_hash": "sha256:pins",
        "harness": "claude",
        "native_root_id": session,
        "actors": [{"key": lead, "parent_actor_key": None, "parent_provenance": "unavailable"}],
        "parent_edges": [],
        "usage": usage,
        "usage_reconciliation": {"status": reconciliation, "categories": {}, "unattributed": None},
        "auxiliary": [dict(receipt, trial_id=trial) for receipt in auxiliary],
        "outcome": outcome,
        "invalid_reason": "usage:mismatch" if outcome == "invalid" else None,
        "verifier": {"id": "fake_answer_file", "exit_code": 0 if outcome == "pass" else 1}
        if outcome in ("pass", "fail")
        else None,
        "patch_hash": "sha256:patch",
        "stop_reason": {"capped": "timeout", "interrupted": "interrupted"}.get(outcome, "exit"),
        "wall_time_s": 1.0,
        "unresolved_actors": [""] if outcome in ("capped", "interrupted") else [],
        "turns": 2,
        "tool_counts": {},
        "cost_usd": None,
        "delivery": {
            "status": "joined" if fires else "unavailable",
            "fires": fires,
            "legs": [],
            "unmatched_fires": [],
        },
        "sentinel": {"public_requests": 0, "credential_exposures": 0},
        "isolation": {"live": False, "publishable": True, "fresh_roots": True, "attested_container": False, "attestation_hash": None, "automated": False},
        "private_hashes": {"root_transcript": "sha256:root", "executor_stderr": None},
    }


def receipt(component: str, phase: str, request: str, input_total: int, output_total: int) -> dict[str, Any]:
    return {
        "trial_id": "",
        "component": component,
        "phase": phase,
        "native_request_id": request,
        "input_total": input_total,
        "output_total": output_total,
        "source_hash": "sha256:receipt",
    }


def accept(*built: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Records keyed the way `records.select` hands them to the reducer."""
    accepted = {}
    for record in built:
        records.validate(record)
        accepted[record["trial_id"]] = record
    return accepted


def read_rows(path: Path) -> list[Any]:
    """Rows as dicts, or the raw line when it is not JSON (malformed fixtures)."""
    rows: list[Any] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append(line)
    return rows


def write_rows(path: Path, rows: list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(row if isinstance(row, str) else json.dumps(row))
            handle.write("\n")


def copy_session(tmp: Path, session: str, edit: Edit | None = None, children: dict[str, Edit] | None = None) -> Path:
    """Copy one fixture session into `tmp/sessions`, optionally rewriting rows."""
    target = tmp / "sessions"
    rows = read_rows(SESSIONS / f"{session}.jsonl")
    write_rows(target / f"{session}.jsonl", edit(rows) if edit else rows)
    source_children = SESSIONS / session / "subagents"
    if source_children.is_dir():
        shutil.copytree(source_children, target / session / "subagents")
    for agent_id, child_edit in (children or {}).items():
        child = target / session / "subagents" / f"agent-{agent_id}.jsonl"
        write_rows(child, child_edit(read_rows(child) if child.is_file() else []))
    return target


def parse(session: str, sessions: Path = SESSIONS) -> claude_usage.SessionUsage:
    return claude_usage.parse_session_dir(sessions, session, TRIAL)


def attempt_record(session: claude_usage.SessionUsage, **overrides: Any) -> dict[str, Any]:
    """A complete, valid attempt record around one parsed session."""
    manifest_hash, schedule_hash = "sha256:manifest", "sha256:schedule"
    task_id, arm_id, repeat, position = "answer-file", "off", 0, 0
    record: dict[str, Any] = {
        "schema": records.RECORD_SCHEMA,
        "trial_id": schedule.trial_id(manifest_hash, task_id, arm_id, repeat, position),
        "manifest_hash": manifest_hash,
        "schedule_hash": schedule_hash,
        "task_id": task_id,
        "arm_id": arm_id,
        "repeat": repeat,
        "position": position,
        "settings_hash": "sha256:off",
        "environment_hash": "sha256:pins",
        "harness": "claude",
        **session.record_fields(),
        "auxiliary": [],
        "outcome": "pass",
        "invalid_reason": None,
        "verifier": {"id": "fake_answer_file", "exit_code": 0},
        "patch_hash": "sha256:patch",
        "stop_reason": "exit",
        "wall_time_s": 1.5,
        "unresolved_actors": [],
        "delivery": {"status": "unavailable", "fires": [], "legs": [], "unmatched_fires": []},
        "sentinel": {"public_requests": 0, "credential_exposures": 0},
        "isolation": {"live": False, "publishable": True, "fresh_roots": True, "attested_container": False, "attestation_hash": None, "automated": False},
        "private_hashes": {"root_transcript": "sha256:root", "executor_stderr": None},
    }
    record.update(overrides)
    for item in record["usage"]:
        item["trial_id"] = record["trial_id"]
    return record


EXACT_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
def fake_toolchain(tmp: Path, cached: tuple[str, ...] = ("11.11.0",), shim: bool = True) -> dict[str, str]:
    """A `pnpm` on PATH and a corepack cache under `COREPACK_HOME`, so no case reads the host's."""
    bin_dir = tmp / "toolchain" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    pnpm = bin_dir / "pnpm"
    if shim:
        pnpm.write_text("#!/usr/bin/env node\nprocess.env.COREPACK_ENABLE_DOWNLOAD_PROMPT??='1'\nrequire('./lib/corepack.cjs').runMain(['pnpm']);\n", encoding="utf-8")
    else:
        pnpm.write_text("#!/bin/sh\necho 11.11.0\n", encoding="utf-8")
    pnpm.chmod(0o755)
    home = tmp / "toolchain" / "corepack"
    for version in cached:
        (home / "v1" / "pnpm" / version).mkdir(parents=True, exist_ok=True)
        (home / "v1" / "pnpm" / version / "package.json").write_text(f'{{"name":"pnpm","version":"{version}"}}\n', encoding="utf-8")
        (home / "v1" / "pnpm" / version / "bin").mkdir(exist_ok=True)
        (home / "v1" / "pnpm" / version / "bin" / "pnpm.cjs").write_text("// fake\n", encoding="utf-8")
    # The fake pnpm comes first; the host PATH stays behind it so `ps` and `node` still resolve.
    return {"PATH": os.pathsep.join([str(bin_dir), os.environ.get("PATH", "")]), "COREPACK_HOME": str(home)}


# Files a run leaves behind. A frozen fixture carries none of them.
RUN_ARTEFACTS = (
    ".bench1",
    "node_modules/.vite",
    "node_modules/.vite-temp",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm",
    "node_modules/.package-map.json",
    "node_modules/.pnpm-workspace-state-v1.json",
)
# The guard in every fixture's vitest config: a runner that did not come
# through pnpm is refused for a repository reason, in words that name the
# convention and never the command that satisfies it.
PNPM_GUARD = "process.env.npm_config_user_agent"
# A base64 run long enough to be a payload, which a frozen fixture never holds.
BLOB = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
PNPM_GUARD_MESSAGE = "this repository's tests run through pnpm; see the repository convention"


def assert_vitest_fixture(case: Any, fixture: Path, task: str, vendored: vendor.Vendor, *, trap: bool = True, package_dir: str = "", test_ext: str = "mjs") -> None:
    """A live task fixture is a real, frozen Vitest project whose only green path is the lesson.

    Its `node_modules` is derived: the committed tree holds the shim alone, and
    the pinned vitest is the one inside the vendored archive the task names.
    `trap` is the Bench-0 family's barrier (the wrapper script, the pnpm guard,
    the failing shards); a Bench-2 family carries its own real failure instead
    and no barrier. `package_dir` is the workspace package the tests live in.
    """
    root = json.loads((fixture / "package.json").read_text(encoding="utf-8"))
    pinned = root["devDependencies"]["vitest"]
    case.assertRegex(pinned, EXACT_VERSION)
    installed = json.loads(vendor.read_member(vendored, "vitest/package.json").decode("utf-8"))
    case.assertEqual((installed["version"], vendored.record["vitest"]), (pinned, pinned))
    case.assertTrue((fixture / "pnpm-lock.yaml").is_file())
    case.assertEqual(vendored.record["lock_sha256"], "sha256:" + sha256_file(fixture / "pnpm-lock.yaml"))
    case.assertEqual([path.relative_to(fixture).as_posix() for path in (fixture / "node_modules").rglob("*") if path.is_file()], ["node_modules/.bin/vitest"])
    project = fixture / package_dir if package_dir else fixture
    package = json.loads((project / "package.json").read_text(encoding="utf-8"))
    config = (project / "vitest.config.mjs").read_text(encoding="utf-8")
    case.assertIn(f"['./scripts/ran-marker.mjs', {{ task: '{task}' }}]", config)
    case.assertNotIn("pnpm exec", config)
    if trap:
        # The trap: the package script is a wrapper, and the wrapper never reads its arguments.
        case.assertEqual(package["scripts"]["test"], "node scripts/all-tests.mjs")
        case.assertNotIn("argv", (project / "scripts" / "all-tests.mjs").read_text(encoding="utf-8"))
        case.assertIn("'unrelated/**/*.test.mjs'", config)
        case.assertIn(PNPM_GUARD, config)
        case.assertIn(PNPM_GUARD_MESSAGE, config)
        case.assertTrue(list((project / "unrelated").glob("*.test.mjs")))
    else:
        case.assertNotIn(PNPM_GUARD, config)
        case.assertFalse((project / "unrelated").exists())
        case.assertFalse((project / "scripts" / "all-tests.mjs").exists())
    # pnpm 11 reads its settings from pnpm-workspace.yaml and, without this,
    # runs an install before the first `pnpm exec` or `pnpm run` in a fresh
    # tree: a registry download the trial must never make.
    workspace = (fixture / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    case.assertIn("verifyDepsBeforeRun: false", workspace)
    case.assertIn("nodeLinker: hoisted", workspace)
    # The named test is a vitest test, so plain `node` cannot run it, and its cases come from the
    # runner's setup file: nothing in the tree holds them, decodable or not.
    test = (project / "tests" / f"{task}.test.{test_ext}").read_text(encoding="utf-8")
    case.assertIn("from 'vitest'", test)
    case.assertIn("globalThis.__bench1Cases", test)
    case.assertIn("setupFiles: ['./.bench1/cases.setup.mjs']", config)
    case.assertFalse((project / "tests" / "support").exists())
    hidden = REPO_ROOT / "evals" / "benchmark" / "hidden" / task / "cases.json"
    case.assertTrue(hidden.is_file(), f"hidden/{task}/cases.json holds the expected values")
    # Values of three characters or more, so a bare digit is not "revealed" by a version string;
    # the source under test is skipped, since the fix's own tokens (an enum member, a unit) live there.
    expected = {str(entry["expected"]) for entry in json.loads(hidden.read_text(encoding="utf-8")) if len(str(entry["expected"])) >= 3}
    for path in fixture.rglob("*"):
        if path.is_file() and "node_modules" not in path.parts:
            text = path.read_text(encoding="utf-8", errors="replace")
            # The lockfile's integrity hashes are base64 by design and name no expected value.
            if path.name != "pnpm-lock.yaml":
                case.assertIsNone(BLOB.search(text), f"{path.relative_to(fixture)} holds a decodable blob")
            if "src" in path.relative_to(fixture).parts:
                continue
            for value in expected:
                case.assertNotIn(value, text, f"{path.relative_to(fixture)} reveals an expected value")
    for artefact in RUN_ARTEFACTS:
        case.assertFalse((fixture / artefact).exists(), artefact)
        case.assertFalse((project / artefact).exists(), artefact)
    case.assertEqual([path for path in fixture.rglob("*") if path.is_symlink()], [])
