"""Shared fixture helpers for the offline benchmark self-test."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest import mock

from evals.benchmark import (
    FIXTURES,
    REPO_ROOT,
    artifact,
    claude_usage,
    executor,
    images,
    manifest as manifest_module,
    records,
    runner,
    schedule,
    sha256_json,
)

SESSIONS = FIXTURES / "claude" / "sessions"
TRIAL = "trial-fixture"
STORE = REPO_ROOT / "src" / "hooks" / "store.ts"

Edit = Callable[[list[Any]], list[Any]]
Before = Callable[[executor.Launch, artifact.TrialRoots], None]

# The image a live case runs in. Nothing here builds or inspects one: a case
# that reaches `images.require` stubs it with this. The CLI labels are here
# because a built image always carries them and a record whose image cannot
# name its CLI build is refused.
CLI_BUILD = "sha256:" + "cd" * 32
CLI_COMMIT = "9f1c0d3e5a7b2c4d6e8f0a1b3c5d7e9f1a2b3c4d"
IMAGE = images.Image(
    tag="bench2-task:0123456789ab",
    id="sha256:" + "1c" * 32,
    labels={
        "bench2.task": "task",
        "bench2.fixture_hash": "sha256:" + "ab" * 32,
        "bench2.tenjin_cli": CLI_BUILD,
        "bench2.cli_commit": CLI_COMMIT,
    },
)

def tenjin_source(path: Path, *, base_url: str, public_url: str = "https://tenjin.blog", shelf_secret: str | None = None) -> Path:
    """A data dir `tenjin_arm.load_source` accepts: the copied config keys and the three bundles."""
    from evals.benchmark import tenjin_arm

    (path / tenjin_arm.HOOKS_DIR).mkdir(parents=True, exist_ok=True)
    for name in tenjin_arm.BUNDLES:
        (path / tenjin_arm.HOOKS_DIR / name).write_text(f"// placeholder {name}\n", encoding="utf-8")
    config: dict[str, Any] = {"baseUrl": base_url, "publicShelfUrl": public_url}
    if shelf_secret is not None:
        config["shelfBypassSecret"] = shelf_secret
    (path / tenjin_arm.CONFIG_FILE).write_text(json.dumps(config), encoding="utf-8")
    return path


@contextlib.contextmanager
def live_gates() -> Iterator["images.Image"]:
    """Every seam a live case would otherwise take to Docker: the image gate, the image lookup, and the run's egress.

    A case that enters this still builds the real plan and the real argv; what
    it does not do is talk to a daemon.
    """
    from evals.benchmark import cli, container

    with (
        patched_images() as image,
        mock.patch.object(cli, "refuse_without_images", lambda manifest, out=None: None),
        mock.patch.object(container, "start_egress", lambda egress, docker=None: egress),
        mock.patch.object(container, "stop_egress", lambda egress, docker=None: {"proxy": False, "network_removed": False}),
    ):
        yield image


@contextlib.contextmanager
def patched_images(image: "images.Image | None" = None) -> Iterator["images.Image"]:
    """Stub the image lookup and the tree export for one case. No case here reaches Docker."""
    resolved = IMAGE if image is None else image
    with mock.patch.object(images, "require", return_value=resolved), mock.patch.object(images, "export_node_modules", return_value=0):
        yield resolved


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
    concurrency: int | None = None,
    auxiliary_usage: str | dict[str, str] = "none",
    live: bool = False,
    prompt: str = "Write 42 into answer.txt.",
    corpus: dict[str, str] | None = None,
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
            **({} if concurrency is None else {"concurrency": concurrency}),
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
                "auxiliary_usage": auxiliary_usage[arm] if isinstance(auxiliary_usage, dict) else auxiliary_usage,
            }
            for arm in arms
        ],
    }
    if corpus is not None:
        data["corpus"] = corpus
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
    requests: int = 1,
    preamble: int | None = None,
    schedule_hash: str = REDUCE_SCHEDULE_HASH,
) -> dict[str, Any]:
    """A valid attempt record with exactly the token total a reducer case needs.

    The reducer cases are about arithmetic and weighting, so this builds the
    record directly rather than parsing a session; the parse path has its own
    cases in `test_claude_usage.py`.

    `preamble` is the fixed text every request after the first replays: a pure
    cache read, so each extra `requests` adds to the attempt's token total and
    nothing to what the provider had to take in for the first time. That is
    what the round-trip and new-token cases are about, and it needs the
    categories exposed; left alone the record is one request that exposes none,
    as a provider that hides them does.
    """
    if requests > 1 and preamble is None:
        raise ValueError("a record with more than one request needs the preamble each one after the first replays")
    trial = schedule.trial_id(manifest_hash, task_id, arm_id, repeat, position)
    session = f"fake-{trial}"
    lead = ["claude", session, ""]
    input_total = tokens * 2 // 3
    output_total = tokens - input_total
    replays = 0 if preamble is None else (requests - 1) * preamble
    if replays >= input_total:
        raise ValueError("the replayed preamble is the whole attempt's input; give the first request something of its own")

    def row(index: int, input_count: int, cached: int, output_count: int) -> dict[str, Any]:
        return {
            "adapter": "claude",
            "adapter_version": "1",
            "trial_id": trial,
            "actor_key": lead,
            "native_request_id": f"req_{index + 1}",
            "input_total": input_count,
            "uncached_input": None if preamble is None else input_count - cached,
            "cache_read": None if preamble is None else cached,
            "cache_write": None if preamble is None else 0,
            "output_total": output_count,
            "reasoning_output_subset": reasoning if index == 0 else (None if reasoning is None else 0),
            "provider_total": None,
            "native_request_cost": None,
            "completion_state": "complete" if outcome in ("pass", "fail") else "partial",
            "source_hash": "sha256:source",
        }

    usage = [row(0, input_total - replays, 0, output_total)]
    usage += [row(index, preamble or 0, preamble or 0, 0) for index in range(1, requests)]
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
        "schedule_hash": schedule_hash,
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


# One attempt per (task, arm, repeat): its scored tokens, its outcome, and how
# its usage reconciled. Both arms carry a cap they declare, the treatment arm
# carries one infrastructure-invalid attempt, and every task resolves at least
# once in each arm, so a reduction over this corpus exercises every branch.
CORPUS_CELLS: dict[tuple[str, str, int], tuple[int, str, str]] = {
    ("task-0", "off", 0): (10000, "pass", "matched"),
    ("task-0", "off", 1): (10000, "pass", "matched"),
    ("task-1", "off", 0): (12000, "pass", "matched"),
    ("task-1", "off", 1): (12000, "fail", "matched"),
    ("task-2", "off", 0): (8000, "pass", "matched"),
    ("task-2", "off", 1): (4000, "interrupted", "no_envelope"),
    ("task-0", "on", 0): (8000, "pass", "matched"),
    ("task-0", "on", 1): (8000, "pass", "matched"),
    ("task-1", "on", 0): (9000, "pass", "matched"),
    ("task-1", "on", 1): (9000, "invalid", "mismatch"),
    ("task-2", "on", 0): (3000, "capped", "no_envelope"),
    ("task-2", "on", 1): (6000, "pass", "matched"),
}


def fake_corpus(tmp: Path) -> tuple[manifest_module.Manifest, str, Path]:
    """A finished offline run on disk: manifest, schedule hash, and a records directory.

    Built through the same builders the unit cases use rather than checked in,
    so regenerating it moves the reducer's input and its expected arithmetic
    together. Alongside the twelve attempts it writes the three files
    `records.select` has to refuse: another manifest's record, an unfinished
    write, and a file that is not a record at all.
    """
    manifest = synthetic_manifest(tmp, tasks=3, repeats=2, seed=20260907, auxiliary_usage={"off": "none", "on": "exposed"})
    trials = schedule.expand(manifest)
    digest = schedule.schedule_hash(trials)
    records_dir = tmp / "records"
    for trial in trials:
        tokens, outcome, reconciliation = CORPUS_CELLS[(trial.task_id, trial.arm_id, trial.repeat)]
        auxiliary: tuple[dict[str, Any], ...] = ()
        if trial.arm_id == "on":
            auxiliary = (receipt("observer", "consumer", f"aux-obs-{trial.trial_id}", 400, 100),)
            # One capture pays for the whole treatment arm, whichever attempt records it.
            if (trial.task_id, trial.repeat) == ("task-0", 0):
                auxiliary += (receipt("compressor", "capture", "aux-capture-1", 4000, 1000),)
        records.publish(
            records_dir,
            reduction_record(
                trial.task_id,
                trial.arm_id,
                trial.repeat,
                trial.position,
                tokens,
                outcome,
                auxiliary=auxiliary,
                reconciliation=reconciliation,
                deliveries=1 if trial.arm_id == "on" and outcome != "invalid" else 0,
                manifest_hash=manifest.hash,
                schedule_hash=digest,
            ),
        )
    stale = reduction_record("task-0", "off", 0, 0, 10000, "pass", manifest_hash="0" * 64, schedule_hash=digest)
    records.publish(records_dir, stale)
    partial = records.final_path(records_dir, trials[0].trial_id).read_text(encoding="utf-8")
    (records_dir / f"{trials[0].trial_id}.partial.0f0f0f0f.json").write_text(partial, encoding="utf-8")
    (records_dir / "notes.txt").write_text("Not a record. The reducer excludes it as foreign.\n", encoding="utf-8")
    return manifest, digest, records_dir


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


def link_workspace_packages(repo: Path) -> list[str]:
    """The workspace links `pnpm install` would make, for a check that runs without the image.

    A fixture commits no `node_modules` and the installed tree comes out of the
    task's image, but a workspace fixture's hidden test resolves its package by
    specifier. This is the one link that resolution goes through and none of
    the dependency tree, so an offline case can judge the fixture.
    """
    made = []
    for manifest in sorted(repo.glob("packages/*/package.json")):
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        if not name:
            continue
        link = repo / "node_modules" / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(manifest.parent, link.parent))
        made.append(str(name))
    return made


def assert_vitest_fixture(fixture: Path, task: str, *, trap: bool = True, package_dir: str = "", test_ext: str = "mjs") -> None:
    """A live task fixture is a real Vitest project that commits none of its toolchain.

    Its dependency tree is the image's: `pnpm install` ran there at build time,
    so the fixture states the runner it pins and nothing about how it is
    installed. No lockfile, no `.npmrc`, no `node_modules`, no vendored
    archive. `trap` is the Bench-0 family's barrier (the wrapper script, the
    pnpm guard, the failing shards); a Bench-2 family carries its own real
    failure instead and no barrier. `package_dir` is the workspace package the
    tests live in.
    """
    root = json.loads((fixture / "package.json").read_text(encoding="utf-8"))
    pinned = root["devDependencies"]["vitest"]
    assert EXACT_VERSION.match(pinned), pinned
    for absent in ("pnpm-lock.yaml", ".npmrc", "node_modules"):
        assert not (fixture / absent).exists(), f"{task} commits {absent}, which the image owns"
    project = fixture / package_dir if package_dir else fixture
    package = json.loads((project / "package.json").read_text(encoding="utf-8"))
    config = (project / "vitest.config.mjs").read_text(encoding="utf-8")
    assert f"['./scripts/ran-marker.mjs', {{ task: '{task}' }}]" in config
    assert "pnpm exec" not in config
    if trap:
        # The trap: the package script is a wrapper, and the wrapper never reads its arguments.
        assert package["scripts"]["test"] == "node scripts/all-tests.mjs"
        assert "argv" not in (project / "scripts" / "all-tests.mjs").read_text(encoding="utf-8")
        assert "'unrelated/**/*.test.mjs'" in config
        assert PNPM_GUARD in config
        assert PNPM_GUARD_MESSAGE in config
        assert list((project / "unrelated").glob("*.test.mjs"))
    else:
        assert PNPM_GUARD not in config
        assert not (project / "unrelated").exists()
        assert not (project / "scripts" / "all-tests.mjs").exists()
    # pnpm 11 reads its settings from pnpm-workspace.yaml and, without this,
    # runs an install before the first `pnpm exec` or `pnpm run` in a fresh
    # tree: a registry download the trial must never make.
    workspace = (fixture / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    assert "verifyDepsBeforeRun: false" in workspace
    assert "nodeLinker: hoisted" in workspace
    # The named test is a vitest test, so plain `node` cannot run it, and its cases come from the
    # runner's setup file: nothing in the tree holds them, decodable or not.
    test = (project / "tests" / f"{task}.test.{test_ext}").read_text(encoding="utf-8")
    assert "from 'vitest'" in test
    assert "globalThis.__bench1Cases" in test
    assert "setupFiles: ['./.bench1/cases.setup.mjs']" in config
    assert not (project / "tests" / "support").exists()
    hidden = REPO_ROOT / "evals" / "benchmark" / "hidden" / task / "cases.json"
    assert hidden.is_file(), f"hidden/{task}/cases.json holds the expected values"
    # Values of three characters or more, matched as whole tokens, so a bare digit or a word inside
    # an identifier is not "revealed"; the source under test is skipped, since the fix's own tokens
    # (an enum member, a unit) live there.
    expected = {str(entry["expected"]) for entry in json.loads(hidden.read_text(encoding="utf-8")) if len(str(entry["expected"])) >= 3}
    for path in fixture.rglob("*"):
        if path.is_file() and "node_modules" not in path.parts:
            text = path.read_text(encoding="utf-8", errors="replace")
            # The lockfile's integrity hashes are base64 by design and name no expected value.
            if path.name != "pnpm-lock.yaml":
                assert BLOB.search(text) is None, f"{path.relative_to(fixture)} holds a decodable blob"
            if "src" in path.relative_to(fixture).parts:
                continue
            for value in expected:
                assert re.search(r"(?<![A-Za-z0-9])" + re.escape(value) + r"(?![A-Za-z0-9])", text) is None, f"{path.relative_to(fixture)} reveals an expected value"
    for artefact in RUN_ARTEFACTS:
        assert not (fixture / artefact).exists(), artefact
        assert not (project / artefact).exists(), artefact
    assert [path for path in fixture.rglob("*") if path.is_symlink()] == []
