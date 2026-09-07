"""Executor registry: a manifest executor name -> code-owned argv, shell=False.

The fake executor is this module run as a script. It writes synthetic
Claude-shaped JSONL for one root and one child into the trial output root and
never spawns a real tool, so CI exercises the whole chain with zero spend.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import REPO_ROOT


@dataclass(frozen=True)
class Launch:
    argv: list[str]
    cwd: Path
    root_session_id: str


@dataclass(frozen=True)
class ExecutorSpec:
    name: str
    harness: str
    launch: Callable[[str, Path, Path, dict], Launch]


class ExecutorError(ValueError):
    pass


def _fake_launch(trial_id: str, repo: Path, output: Path, arm: dict) -> Launch:
    session = f"fake-{trial_id}"
    argv = [
        sys.executable,
        "-m",
        "evals.benchmark.executor",
        "fake-agent",
        "--repo",
        str(repo),
        "--output",
        str(output),
        "--session",
        session,
        "--seed",
        trial_id,
        "--arm",
        str(arm["id"]),
    ]
    return Launch(argv=argv, cwd=REPO_ROOT, root_session_id=session)


REGISTRY: dict[str, ExecutorSpec] = {
    "fake": ExecutorSpec(name="fake", harness="claude", launch=_fake_launch),
}


def lookup(name: str) -> ExecutorSpec:
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


def _row(kind: str, request_id: str, message_id: str, usage: dict[str, int], **extra: str) -> str:
    return json.dumps(
        {
            "type": kind,
            "requestId": request_id,
            "message": {"id": message_id, "role": "assistant", "usage": usage},
            **extra,
        }
    )


def fake_agent(args: argparse.Namespace) -> int:
    rng = random.Random(args.seed)
    sessions = Path(args.output) / "sessions"
    child_dir = sessions / args.session / "subagents"
    child_dir.mkdir(parents=True, exist_ok=True)
    child_id = f"child-{rng.randrange(1 << 20):05x}"
    # A treatment arm reads slightly less: an arm-shaped difference the reducer
    # must show, not a claim about any product.
    scale = 800 if args.arm == "off" else 600

    root_lines = [json.dumps({"type": "system", "subtype": "init", "session_id": args.session, "model": "fake-model-0"})]
    first = _usage(rng, scale)
    partial = {**first, "output_tokens": 1}
    root_lines.append(_row("assistant", "req_1", "msg_1", partial))
    root_lines.append(_row("assistant", "req_1", "msg_1", first))
    root_lines.append(json.dumps({"type": "user", "message": {"role": "user", "content": "child dispatched"}}))
    root_lines.append(_row("assistant", "req_2", "msg_2", _usage(rng, scale)))
    root_lines.append(json.dumps({"type": "result", "subtype": "success", "num_turns": 2, "total_cost_usd": 0.0, "is_error": False}))
    (sessions / f"{args.session}.jsonl").write_text("\n".join(root_lines) + "\n", encoding="utf-8")

    child_lines = [
        _row("assistant", "req_c1", "msg_c1", _usage(rng, scale // 2), agentId=child_id),
        json.dumps({"type": "result", "subtype": "success", "num_turns": 1, "agentId": child_id}),
    ]
    (child_dir / f"agent-{child_id}.jsonl").write_text("\n".join(child_lines) + "\n", encoding="utf-8")

    (Path(args.repo) / "answer.txt").write_text("42\n", encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals.benchmark.executor")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-agent")
    for flag in ("--repo", "--output", "--session", "--seed", "--arm"):
        fake.add_argument(flag, required=True)
    args = parser.parse_args(argv)
    return fake_agent(args)


if __name__ == "__main__":
    sys.exit(main())
