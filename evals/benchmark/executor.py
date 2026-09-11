"""Executor registry: a manifest executor name -> code-owned argv, shell=False.

The fake executors are this module run as a script. They write synthetic
Claude-shaped JSONL for one root, an optional child, and an optional
grandchild into the trial output root and never spawn a real tool, so CI
exercises the whole chain, recursion included, with zero spend. The rows
follow the shapes `claude_usage.py` freezes.

`live` marks a spec that would start a real agent. The one entry that sets it
is `claude_live`, which lives in its own module and is imported only when a
manifest names it; CI reaches it through `cli.py live-run --dry-run` and
nowhere else. `artifact.require_isolation` refuses a publishable live run
without an isolation attestation, and refuses any live run under CI.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import random
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import REPO_ROOT, artifact, claude_usage
from .native_usage import Adapter

NATIVE = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
BEHAVIORS = ("pass", "wrong-answer", "hang")
# Long enough that only the runner's own cap ends the hang behavior.
HANG_S = 300


class ProvisionError(ValueError):
    """A provisioner's refusal of one trial. `code` is the machine-readable half the record carries as `provision:<code>`."""

    def __init__(self, message: str, code: str = "refused") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Provision:
    """What an arm's provisioning left for its launch, and what the record has to know about it.

    `values` are the per-trial values the arm's settings template resolves to
    (a daemon URL, a bearer token, the data dir). `secrets` are values that
    must never appear in anything the agent writes; the sentinel scan treats
    each as a canary. `origins` are hosts the arm's own product reaches, which
    the attestation has to list. `facts` is the slice of the record's isolation block the provision
    owns: booleans and hosts, never a value from `secrets`.
    """

    values: dict[str, str] = field(default_factory=dict)
    secrets: tuple[str, ...] = field(default_factory=tuple)
    origins: tuple[str, ...] = field(default_factory=tuple)
    facts: dict[str, Any] = field(default_factory=dict)
    stop_state: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProvisionRequest:
    trial_id: str
    roots: artifact.TrialRoots
    arm: dict[str, Any]
    source: Any
    dry_run: bool = False
    # The task the trial runs, for a provisioner that seeds something task-shaped
    # (the hooks arm's lesson), and the child environment a probe inside the
    # trial's repository copy runs under. A dry run carries neither.
    task: dict[str, Any] | None = None
    environment: dict[str, str] | None = None
    # Minted once per `live-run` invocation and reused on resume, so what a
    # provisioner writes to a shelf differs between runs of the same schedule.
    nonce: str | None = None
    # The fixture image a probe runs in, so a provisioner that runs the task's
    # own commands runs them where the agent will: same image, same tree.
    image: str | None = None


# An arm that declares `provision` is prepared before its launch and stopped
# after its process exits; `prepare` returns the values the launch resolves its
# settings template with, and `stop` ends what `prepare` started and waits for
# its state to settle on disk. Both are code-owned by the executor's module.
Prepare = Callable[[ProvisionRequest], Provision]
Stop = Callable[[artifact.TrialRoots, Provision], dict[str, Any]]


@dataclass(frozen=True)
class LaunchRequest:
    """Everything a spec may read to build one attempt's argv. All of it data."""

    trial_id: str
    roots: artifact.TrialRoots
    task: dict[str, Any]
    arm: dict[str, Any]
    pins: dict[str, Any]
    provision: Provision | None = None
    # A dry run builds the launch and starts nothing, so a spec that seeds or
    # probes the host toolchain reports what it would do instead of doing it.
    dry_run: bool = False
    # The consumer by default; the natural arm's producer runs first under the
    # same trial with its own session, so the phase is part of the session id.
    phase: str | None = None
    # The image this attempt runs in, by id once the run has resolved it. A dry
    # run leaves it None and the spec derives the tag from the task, so
    # building an argv never needs Docker.
    image: str | None = None
    # The run's egress (`container.Egress`): the network the container joins
    # and the proxy variables it is given. None outside a live run.
    egress: Any = None


@dataclass(frozen=True)
class Launch:
    argv: list[str]
    cwd: Path
    root_session_id: str
    # A spec that needs more than the roots' own allowlist (a live one needs
    # the credential seam) owns its child environment here. `None` keeps the
    # roots' default, which is what every fake spec uses.
    env: dict[str, str] | None = None
    # The hash of the settings fragment the child actually read, when the arm's
    # declared fragment is a template resolved per trial. The record keeps it
    # under `private_hashes`: the resolved bytes hold a bearer token.
    resolved_settings_hash: str | None = None
    # The package manager the child runs, recorded in the attempt's isolation
    # block by a live spec. For a container trial it is the image's pnpm.
    package_manager: dict[str, Any] | None = None
    # The plan a dry run prints for the container this attempt runs in. What
    # the container IS is `recipe` below; this is only its readable form.
    container_plan: dict[str, Any] | None = None
    # What a container spawn needs to bring the environment up and exec into
    # it: a `container.Recipe`. `argv` above stays the agent's own command, so
    # a fake spec and a live one describe the same thing and only the seam that
    # runs it differs. None is a launch that starts no container.
    recipe: Any = None


# Where a finished trial's transcripts are, given its roots and root session
# id. The fakes write under the output root; a live harness writes wherever it
# keeps sessions inside the trial's own HOME.
SessionsResolver = Callable[[artifact.TrialRoots, str], Path]


def output_sessions(roots: artifact.TrialRoots, root_session_id: str) -> Path:
    return roots.output / "sessions"


# The credential variable a live spec passes into the child, read from the
# manifest's pins. The attestation has to name the same one, and the operator
# command refuses before spend when the shell does not have it set.
CredentialSeam = Callable[[dict[str, Any]], str]


@dataclass(frozen=True)
class ExecutorSpec:
    name: str
    harness: str
    launch: Callable[[LaunchRequest], Launch]
    live: bool = False
    required_origins: tuple[str, ...] = field(default_factory=tuple)
    sessions: SessionsResolver = output_sessions
    credential_seam: CredentialSeam | None = None
    prepare: Prepare | None = None
    stop: Stop | None = None
    evidence: Adapter = claude_usage.EVIDENCE


class ExecutorError(ValueError):
    pass


def _fake_launch(behavior: str) -> Callable[[LaunchRequest], Launch]:
    def launch(request: LaunchRequest) -> Launch:
        session = f"fake-{request.trial_id}" if request.phase is None else f"fake-{request.trial_id}-{request.phase}"
        argv = [
            sys.executable,
            "-m",
            "evals.benchmark.executor",
            "fake-agent",
            "--behavior",
            behavior,
            "--repo",
            str(request.roots.repo),
            "--output",
            str(request.roots.output),
            "--session",
            session,
            "--seed",
            request.trial_id,
            "--arm",
            str(request.arm["id"]),
        ]
        return Launch(argv=argv, cwd=REPO_ROOT, root_session_id=session)

    return launch


REGISTRY: dict[str, ExecutorSpec] = {
    "fake": ExecutorSpec(name="fake", harness="claude", launch=_fake_launch("pass")),
    # The null agent. It does the work badly rather than not at all, because
    # what it exists to catch is a verifier that returns `pass` whatever is in
    # the worktree: an agent that wrote nothing would fail on the missing file
    # instead, which a broken verifier would also do.
    "fake_wrong": ExecutorSpec(name="fake_wrong", harness="claude", launch=_fake_launch("wrong-answer")),
    "fake_hang": ExecutorSpec(name="fake_hang", harness="claude", launch=_fake_launch("hang")),
}

# An executor whose implementation is its own module registers itself when that
# module is imported. Naming the module here keeps `lookup` the single entry
# point without importing a live executor into every process that loads this
# one, and without a circular import back from that module.
DEFERRED = {"claude_live": "evals.benchmark.claude_live", "codex_live": "evals.benchmark.codex_live"}


def lookup(name: str) -> ExecutorSpec:
    if name not in REGISTRY and name in DEFERRED:
        importlib.import_module(DEFERRED[name])
    spec = REGISTRY.get(name)
    if spec is None:
        raise ExecutorError(f"unknown executor {name!r}")
    return spec


def _usage(rng: random.Random, scale: int) -> dict[str, int]:
    return {
        "input_tokens": rng.randint(scale, scale * 3),
        "cache_creation_input_tokens": rng.randint(0, scale),
        "cache_read_input_tokens": rng.randint(0, scale * 4),
        "output_tokens": rng.randint(scale // 4, scale),
    }


def _row(
    session: str,
    request_id: str,
    message_id: str,
    usage: dict[str, int],
    content: list[dict[str, Any]],
    stop_reason: str | None,
    **extra: Any,
) -> str:
    return json.dumps(
        {
            "type": "assistant",
            "session_id": session,
            "requestId": request_id,
            "parent_tool_use_id": None,
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": "fake-model-0",
                "content": content,
                "stop_reason": stop_reason,
                "usage": usage,
            },
            **extra,
        }
    )


def write_transcripts(
    output: Path,
    session: str,
    seed: str,
    arm: str,
    *,
    child: bool = True,
    grandchild: bool = False,
    settled: bool = True,
) -> None:
    """Write one root (and optionally a child and a grandchild) transcript.

    `grandchild=True` makes the child dispatch a Task of its own, so the trial
    is a three-level actor tree whose edges are both structured native ones:
    the grandchild names the child's tool call, the child names the root's.

    `settled=False` leaves the root without its result envelope and every
    descendant without a terminal row, which is what an interrupted or
    still-running attempt looks like on disk.
    """
    rng = random.Random(seed)
    sessions = Path(output) / "sessions"
    child_dir = sessions / session / "subagents"
    child_dir.mkdir(parents=True, exist_ok=True)
    child_id = f"child-{rng.randrange(1 << 20):05x}"
    # Its own generator: drawing the grandchild id from `rng` would move every
    # later draw and change the token totals of runs that have no grandchild.
    grand_id = f"grand-{random.Random(f'{seed}:grand').randrange(1 << 20):05x}"
    grandchild = grandchild and child
    # A treatment arm reads slightly less: an arm-shaped difference the reducer
    # must show, not a claim about any product.
    scale = 800 if arm == "off" else 600
    text = [{"type": "text", "text": "[redacted]"}]
    dispatch = [{"type": "tool_use", "id": "toolu_dispatch", "name": "Task", "input": {}}]
    dispatch_grand = [{"type": "tool_use", "id": "toolu_grand", "name": "Task", "input": {}}]

    first, second = _usage(rng, scale), _usage(rng, scale)
    child_usage, child_second, grand_usage = _usage(rng, scale // 2), _usage(rng, scale // 2), _usage(rng, scale // 4)
    root_lines = [json.dumps({"type": "system", "subtype": "init", "session_id": session, "model": "fake-model-0"})]
    root_lines.append(_row(session, "req_1", "msg_1", {**first, "output_tokens": 1}, text, None))
    if not settled:
        (sessions / f"{session}.jsonl").write_text("\n".join(root_lines) + "\n", encoding="utf-8")
        if child:
            (child_dir / f"agent-{child_id}.jsonl").write_text(
                _row(
                    session,
                    "req_c1",
                    "msg_c1",
                    child_usage,
                    dispatch_grand if grandchild else text,
                    None,
                    agentId=child_id,
                    parent_tool_use_id="toolu_dispatch",
                )
                + "\n",
                encoding="utf-8",
            )
        if grandchild:
            (child_dir / f"agent-{grand_id}.jsonl").write_text(
                _row(session, "req_g1", "msg_g1", grand_usage, text, None, agentId=grand_id, parent_tool_use_id="toolu_grand")
                + "\n",
                encoding="utf-8",
            )
        return
    root_lines.append(_row(session, "req_1", "msg_1", first, dispatch, "tool_use"))
    root_lines.append(
        json.dumps(
            {
                "type": "user",
                "session_id": session,
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_dispatch", "content": "[redacted]"}],
                },
            }
        )
    )
    root_lines.append(_row(session, "req_2", "msg_2", second, text, "end_turn"))
    root_lines.append(
        json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "num_turns": 2,
                "total_cost_usd": 0.0,
                "session_id": session,
                "usage": {name: first[name] + second[name] for name in NATIVE},
                "modelUsage": {"fake-model-0": {"inputTokens": first["input_tokens"] + second["input_tokens"]}},
            }
        )
    )
    (sessions / f"{session}.jsonl").write_text("\n".join(root_lines) + "\n", encoding="utf-8")
    if not child:
        return
    child_lines: list[str] = []
    if grandchild:
        child_lines.append(
            _row(
                session,
                "req_c1",
                "msg_c1",
                child_usage,
                dispatch_grand,
                "tool_use",
                agentId=child_id,
                parent_tool_use_id="toolu_dispatch",
            )
        )
        child_lines.append(
            json.dumps(
                {
                    "type": "user",
                    "session_id": session,
                    "agentId": child_id,
                    "message": {
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": "toolu_grand", "content": "[redacted]"}],
                    },
                }
            )
        )
        child_lines.append(
            _row(session, "req_c2", "msg_c2", child_second, text, "end_turn", agentId=child_id, parent_tool_use_id="toolu_dispatch")
        )
    else:
        child_lines.append(
            _row(session, "req_c1", "msg_c1", child_usage, text, "end_turn", agentId=child_id, parent_tool_use_id="toolu_dispatch")
        )
    child_lines.append(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "agentId": child_id}))
    (child_dir / f"agent-{child_id}.jsonl").write_text("\n".join(child_lines) + "\n", encoding="utf-8")
    if not grandchild:
        return
    grand_lines = [
        _row(session, "req_g1", "msg_g1", grand_usage, text, "end_turn", agentId=grand_id, parent_tool_use_id="toolu_grand"),
        json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "agentId": grand_id}),
    ]
    (child_dir / f"agent-{grand_id}.jsonl").write_text("\n".join(grand_lines) + "\n", encoding="utf-8")


def settle_child(output: Path, session: str) -> None:
    """Append the terminal row a child transcript is still missing."""
    for child in sorted((Path(output) / "sessions" / session / "subagents").glob("agent-*.jsonl")):
        agent_id = child.stem.removeprefix("agent-")
        with child.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "agentId": agent_id}))
            handle.write("\n")


def fake_agent(args: argparse.Namespace) -> int:
    output, repo = Path(args.output), Path(args.repo)
    if args.behavior == "hang":
        # A grandchild in the same process group: the timeout case is only
        # proven if killing the group reaches it too.
        grandchild = subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({HANG_S})"], shell=False)
        write_transcripts(output, args.session, args.seed, args.arm, child=False, settled=False)
        (output / "pids.json").write_text(json.dumps({"root": os.getpid(), "grandchild": grandchild.pid}), encoding="utf-8")
        time.sleep(HANG_S)
        return 0
    write_transcripts(output, args.session, args.seed, args.arm)
    (repo / "answer.txt").write_text("42\n" if args.behavior == "pass" else "41\n", encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals.benchmark.executor")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-agent")
    for flag in ("--repo", "--output", "--session", "--seed", "--arm"):
        fake.add_argument(flag, required=True)
    fake.add_argument("--behavior", choices=BEHAVIORS, default="pass")
    args = parser.parse_args(argv)
    return fake_agent(args)


if __name__ == "__main__":
    sys.exit(main())
