"""Hidden verifier registry: code-owned argv, shell=False, bounded output.

A verifier runs only after every model process has stopped, on a copy of the
final worktree the agent never saw. The expected answer lives in this module
or in a code-owned hidden layer that `artifact.hidden_copy` mounts into that
copy after shutdown, never in the agent-visible fixture. Exit 0 is pass, 1 is
fail, anything else is invalid: the measurement, not the task, is what broke.

A manifest names a verifier; it never supplies one. An unknown name, a target
outside the run directory, and a shell-shaped value all fail closed here, and
the verifier process gets the same treatment as the agent's: an allowlisted
environment rather than the operator's, so a wallet or shelf variable is not
in scope for code that reads a trial's final worktree.

A task verifier decides two things: the hidden test passes on the retained
worktree, and the run marker the fixture's vitest reporter writes on a green
run names exactly the one test file the prompt asked for. The marker is
evidence that the named test ran green inside the trial, not proof: the
agent can write any file, so the transcript's tool counts stay the primary
record of what ran.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from . import PACKAGE_ROOT, REPO_ROOT

OUTPUT_LIMIT = 800
# Code-owned hidden layers, one directory per task, mounted into the
# verifier's copy after shutdown. The agent-visible fixture never holds them.
HIDDEN = PACKAGE_ROOT / "hidden"
HIDDEN_TESTS = "hidden-tests"
# Where the fixture's `scripts/ran-marker.mjs` reporter records a green run.
MARKER_DIR = ".bench1"
NODE = "node"
# What a `python3 -m` child needs to run at all. Everything else the operator
# happens to have exported stays out of the verifier process.
INHERITED = ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT")


def child_environment(parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """An allowlist, not the operator's environment with additions."""
    source = os.environ if parent is None else parent
    return {name: source[name] for name in INHERITED if source.get(name)}


@dataclass(frozen=True)
class VerifierSpec:
    name: str
    argv: Callable[[Path], list[str]]
    timeout_s: int
    hidden_layer: Path | None = None


@dataclass(frozen=True)
class Verdict:
    verifier_id: str
    outcome: str
    exit_code: int | None
    detail: str


class VerifierError(ValueError):
    pass


def _fake_answer_file(repo: Path) -> list[str]:
    return [sys.executable, "-m", "evals.benchmark.verifier", "fake-answer-file", "--repo", str(repo)]


def _fake_crash(repo: Path) -> list[str]:
    return [sys.executable, "-m", "evals.benchmark.verifier", "fake-crash", "--repo", str(repo)]


def _node_test(task: str) -> Callable[[Path], list[str]]:
    """A Node test from the task's hidden layer, run inside the verifier's copy."""

    def argv(repo: Path) -> list[str]:
        return [sys.executable, "-m", "evals.benchmark.verifier", "node-test", "--repo", str(repo), "--test", f"{HIDDEN_TESTS}/{task}.test.mjs", "--task", task]

    return argv


def node_test_spec(task: str) -> VerifierSpec:
    return VerifierSpec(name=f"node_test_{task}", argv=_node_test(task), timeout_s=60, hidden_layer=HIDDEN / task)


REGISTRY: dict[str, VerifierSpec] = {
    "fake_answer_file": VerifierSpec(name="fake_answer_file", argv=_fake_answer_file, timeout_s=30),
    "fake_crash": VerifierSpec(name="fake_crash", argv=_fake_crash, timeout_s=30),
}


def lookup(name: str) -> VerifierSpec:
    spec = REGISTRY.get(name)
    if spec is None:
        raise VerifierError(f"unknown verifier {name!r}")
    return spec


def run(spec: VerifierSpec, repo_copy: Path, allowed_root: Path) -> Verdict:
    resolved = repo_copy.resolve()
    if not resolved.is_relative_to(allowed_root.resolve()):
        raise VerifierError("verifier target escapes the run directory")
    if not resolved.is_dir():
        raise VerifierError("verifier target is not a directory")
    argv = spec.argv(resolved)
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item for item in argv):
        raise VerifierError(f"verifier {spec.name!r} did not produce an argv list")
    try:
        completed = subprocess.run(
            argv,
            cwd=REPO_ROOT,
            env=child_environment(),
            capture_output=True,
            text=True,
            timeout=spec.timeout_s,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return Verdict(spec.name, "invalid", None, "verifier timed out")
    detail = (completed.stderr or completed.stdout).strip()[-OUTPUT_LIMIT:]
    return Verdict(spec.name, outcome_of(completed.returncode), completed.returncode, detail)


def outcome_of(exit_code: int | None) -> str:
    """Exit 0 is pass, 1 is fail, anything else means the verifier could not decide."""
    return {0: "pass", 1: "fail"}.get(exit_code, "invalid")  # type: ignore[arg-type]


def fake_answer_file(repo: Path) -> int:
    answer = repo / "answer.txt"
    if not answer.is_file():
        print("answer.txt missing")
        return 1
    if answer.read_text(encoding="utf-8") != "42\n":
        print("answer.txt has the wrong content")
        return 1
    return 0


def marker_path(repo: Path, task: str) -> Path:
    return repo / MARKER_DIR / f"ran-{task}.json"


def check_marker(repo: Path, task: str) -> str | None:
    """Why the run marker does not show `tests/<task>.test.mjs` ran green alone, or None."""
    expected = f"tests/{task}.test.mjs"
    path = marker_path(repo, task)
    if not path.is_file():
        return f"no run marker at {MARKER_DIR}/ran-{task}.json: {expected} never ran green inside the trial"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return "run marker is not readable JSON"
    if not isinstance(data, dict) or data.get("task") != task:
        return f"run marker does not name task {task!r}"
    files = data.get("files")
    if files != [expected]:
        return f"run marker names {files!r} rather than exactly [{expected!r}]"
    passed = data.get("passed")
    if not isinstance(passed, int) or isinstance(passed, bool) or passed < 1 or data.get("failed") != 0:
        return "run marker does not record a green run"
    return None


def node_test(repo: Path, test: str, task: str) -> int:
    """Run one hidden Node test in the copy, then require the run marker. 0 and 1 are the verdict; anything else is ours."""
    target = repo / test
    if not target.is_file():
        print(f"hidden test {test} is not mounted")
        return 3
    try:
        completed = subprocess.run([NODE, str(target)], cwd=repo, env=child_environment(), capture_output=True, text=True, shell=False, check=False)
    except FileNotFoundError:
        print("node is not on PATH")
        return 3
    sys.stdout.write(completed.stdout[-OUTPUT_LIMIT:])
    sys.stderr.write(completed.stderr[-OUTPUT_LIMIT:])
    if completed.returncode != 0:
        return 1 if completed.returncode == 1 else 3
    reason = check_marker(repo, task)
    if reason is not None:
        print(reason)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals.benchmark.verifier")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("fake-answer-file", "fake-crash"):
        commands.add_parser(name).add_argument("--repo", required=True)
    node = commands.add_parser("node-test")
    node.add_argument("--repo", required=True)
    node.add_argument("--test", required=True)
    node.add_argument("--task", required=True)
    args = parser.parse_args(argv)
    if args.command == "fake-crash":
        # A verifier that cannot decide. The attempt is invalid, not failed.
        print("fake verifier crashed")
        return 3
    if args.command == "node-test":
        return node_test(Path(args.repo), args.test, args.task)
    return fake_answer_file(Path(args.repo))


if __name__ == "__main__":
    sys.exit(main())
