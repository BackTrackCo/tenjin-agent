"""Hidden verifier registry: code-owned argv, shell=False, bounded output.

A verifier runs only after every model process has stopped, on a copy of the
final worktree the agent never saw. The expected answer lives in this module,
not in the agent-visible fixture. Exit 0 is pass, 1 is fail, anything else is
invalid: the measurement, not the task, is what broke.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import REPO_ROOT

OUTPUT_LIMIT = 800


@dataclass(frozen=True)
class VerifierSpec:
    name: str
    argv: Callable[[Path], list[str]]
    timeout_s: int


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


REGISTRY: dict[str, VerifierSpec] = {
    "fake_answer_file": VerifierSpec(name="fake_answer_file", argv=_fake_answer_file, timeout_s=30),
}


def lookup(name: str) -> VerifierSpec:
    spec = REGISTRY.get(name)
    if spec is None:
        raise VerifierError(f"unknown verifier {name!r}")
    return spec


def run(spec: VerifierSpec, repo_copy: Path, allowed_root: Path) -> Verdict:
    repo_copy = repo_copy.resolve()
    if not repo_copy.is_relative_to(allowed_root.resolve()):
        raise VerifierError("verifier target escapes the run directory")
    try:
        completed = subprocess.run(
            spec.argv(repo_copy),
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=spec.timeout_s,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return Verdict(spec.name, "invalid", None, "verifier timed out")
    detail = (completed.stderr or completed.stdout).strip()[-OUTPUT_LIMIT:]
    outcome = {0: "pass", 1: "fail"}.get(completed.returncode, "invalid")
    return Verdict(spec.name, outcome, completed.returncode, detail)


def fake_answer_file(repo: Path) -> int:
    answer = repo / "answer.txt"
    if not answer.is_file():
        print("answer.txt missing")
        return 1
    if answer.read_text(encoding="utf-8") != "42\n":
        print("answer.txt has the wrong content")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals.benchmark.verifier")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-answer-file")
    fake.add_argument("--repo", required=True)
    args = parser.parse_args(argv)
    return fake_answer_file(Path(args.repo))


if __name__ == "__main__":
    sys.exit(main())
