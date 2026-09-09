"""Cleanup is the package's job, not a judgment call.

The case these hold to: a benchmark process is killed by identity, never by
name. A cleanup that matches a command line, `pkill -f bin/claude` and its
relatives, also matches an operator's own unrelated sessions, and it has done
so on this repository. So the ledger is the only input, every record is checked
against the live process before a signal, and a spawn that raises still leaves
nothing running.
"""

from __future__ import annotations

import ast
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

import pytest

from evals.benchmark import artifact, executor, reap, runner

STARTED = "Mon Sep  7 10:00:00 2026"
Record = Callable[..., None]


def fake_probe(table: dict[int, tuple[str, int]]):
    def probe(pid: int) -> tuple[str, int] | None:
        return table.get(pid)

    return probe


def alive(pid: int) -> bool:
    return reap.probe(pid) is not None


@pytest.fixture
def run(tmp_path: Path) -> Path:
    return tmp_path


def test_a_record_names_the_group_and_its_start_time(run: Path) -> None:
    record = reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({41: (STARTED, 41)}))
    assert record is not None
    assert [item.pid for item in reap.read_records(run)] == [41]
    assert reap.read_records(run)[0].started == STARTED


def test_a_process_that_already_exited_is_not_recorded(run: Path) -> None:
    assert reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({})) is None
    assert reap.read_records(run) == []


def test_a_child_sharing_our_group_is_refused_rather_than_recorded(run: Path) -> None:
    # Recording it would mean a later reap signals this interpreter's group.
    with pytest.raises(reap.ReapError):
        reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({41: (STARTED, os.getpgid(0))}))


def test_release_removes_the_record(run: Path) -> None:
    reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({41: ("t", 41)}))
    reap.release(run, "t1")
    assert reap.read_records(run) == []


def test_a_corrupt_record_is_an_error_rather_than_an_empty_ledger(run: Path) -> None:
    reap.ledger_dir(run).mkdir(parents=True)
    (reap.ledger_dir(run) / "t1.json").write_text("{", encoding="utf-8")
    with pytest.raises(reap.ReapError):
        reap.read_records(run)


@pytest.fixture
def signals() -> list[tuple[int, int]]:
    return []


@pytest.fixture
def signaller(signals: list[tuple[int, int]]) -> Callable[[int, int], None]:
    def send(pgid: int, sig: int) -> None:
        signals.append((pgid, sig))

    return send


@pytest.fixture
def record(run: Path) -> Record:
    def write(trial: str, pid: int, started: str = STARTED) -> None:
        reap.register(run, trial, pid, "claude", probe_fn=fake_probe({pid: (started, pid)}))

    return write


def test_a_live_recorded_group_is_signalled_and_its_record_cleared(run: Path, record: Record, signaller, signals) -> None:
    record("t1", 41)
    report = reap.reap(run, probe_fn=fake_probe({41: (STARTED, 41)}), signal_fn=signaller, sleep=lambda _: None)
    assert report["killed"] == ["t1"]
    assert signals == [(41, signal.SIGTERM), (41, signal.SIGKILL)]
    assert reap.read_records(run) == []


def test_a_group_that_dies_on_the_first_signal_is_not_killed_twice(run: Path, record: Record, signals) -> None:
    record("t1", 41)
    table = {41: (STARTED, 41)}

    def send(pgid: int, sig: int) -> None:
        signals.append((pgid, sig))
        table.pop(pgid, None)

    reap.reap(run, probe_fn=fake_probe(table), signal_fn=send, sleep=lambda _: None)
    assert signals == [(41, signal.SIGTERM)]


def test_an_exited_process_is_reported_gone_and_never_signalled(run: Path, record: Record, signaller, signals) -> None:
    record("t1", 41)
    report = reap.reap(run, probe_fn=fake_probe({}), signal_fn=signaller, sleep=lambda _: None)
    assert report["outcomes"] == {"t1": "gone"}
    assert signals == []


def test_a_recycled_pid_is_refused_because_it_is_now_a_stranger(run: Path, record: Record, signaller, signals) -> None:
    # The exact accident this module exists to prevent: the number is ours,
    # the process is not.
    record("t1", 41)
    report = reap.reap(run, probe_fn=fake_probe({41: ("Mon Sep  7 18:35:00 2026", 41)}), signal_fn=signaller, sleep=lambda _: None)
    assert report["refused"] == ["t1"]
    assert signals == []
    assert reap.read_records(run) == []


def test_a_process_that_left_its_group_is_refused(run: Path, record: Record, signaller, signals) -> None:
    record("t1", 41)
    report = reap.reap(run, probe_fn=fake_probe({41: (STARTED, 999)}), signal_fn=signaller, sleep=lambda _: None)
    assert report["refused"] == ["t1"]
    assert signals == []


def test_it_never_signals_a_group_it_did_not_record(run: Path, record: Record, signaller, signals) -> None:
    record("t1", 41)
    table = {41: (STARTED, 41), 77: (STARTED, 77)}
    reap.reap(run, probe_fn=fake_probe(table), signal_fn=signaller, sleep=lambda _: None)
    assert {pgid for pgid, _ in signals} == {41}


def test_an_empty_ledger_signals_nothing(run: Path, signaller, signals) -> None:
    report = reap.reap(run, probe_fn=fake_probe({}), signal_fn=signaller, sleep=lambda _: None)
    assert report["outcomes"] == {}
    assert signals == []


def test_no_module_can_kill_by_matching_a_process_name() -> None:
    # A name match is what reached an operator's unrelated sessions, so the
    # ban is executable rather than remembered. Prose may name the mistake:
    # only real code is searched, docstrings and comments excluded, and this
    # module is skipped because the pattern it looks for is written here.
    offenders: list[str] = []
    for path in sorted(Path(reap.__file__).resolve().parent.rglob("*.py")):
        if path.resolve() == Path(__file__).resolve():
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docstrings = {
            id(node.body[0].value)
            for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                if "pkill" in node.value or "killall" in node.value:
                    offenders.append(f"{path.name}:{node.lineno}")
            if isinstance(node, ast.Name) and ("pkill" in node.id or "killall" in node.id):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], "a name-matching kill is never the cleanup"


# The real thing: a spawned process, a real signal, a real ledger.


@pytest.fixture
def roots(run: Path, tmp_path: Path) -> artifact.TrialRoots:
    fixture = tmp_path / "fixture" / "repo"
    fixture.mkdir(parents=True)
    (fixture / "TASK.md").write_text("nothing\n", encoding="utf-8")
    return artifact.create(run, "trial-1", fixture)


def sleeper(roots: artifact.TrialRoots, seconds: int) -> executor.Launch:
    return executor.Launch(argv=[sys.executable, "-c", f"import time; time.sleep({seconds})"], cwd=roots.repo, root_session_id="s1")


def test_a_timeout_kills_the_group_and_clears_its_record(run: Path, roots: artifact.TrialRoots) -> None:
    completed = runner.process_spawn(sleeper(roots, 30), roots, timeout_s=0.4)
    assert completed.timed_out
    assert reap.read_records(run) == []
    assert reap.survivors(run) == []


def test_an_interrupt_on_the_way_out_still_leaves_nothing_running(run: Path, roots: artifact.TrialRoots) -> None:
    # The leak that made a person reach for a name match: an exception
    # between the spawn and the wait. The finally-path owns it.
    pids: list[int] = []
    real_communicate = subprocess.Popen.communicate

    def explode(self_process, *args, **kwargs):  # type: ignore[no-untyped-def]
        pids.append(self_process.pid)
        raise KeyboardInterrupt("operator stopped the run")

    subprocess.Popen.communicate = explode  # type: ignore[assignment]
    try:
        with pytest.raises(KeyboardInterrupt):
            runner.process_spawn(sleeper(roots, 30), roots, timeout_s=30)
    finally:
        subprocess.Popen.communicate = real_communicate  # type: ignore[assignment]

    assert len(pids) == 1
    deadline = time.monotonic() + 5
    while alive(pids[0]) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not alive(pids[0]), "the interrupted spawn left a process running"
    assert reap.read_records(run) == []


def test_cleanup_reaps_a_recorded_group_left_behind(run: Path, roots: artifact.TrialRoots) -> None:
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
    )
    try:
        reap.register(run, "trial-2", process.pid, sys.executable)
        report = reap.reap(run, grace_s=0.2)
        assert report["killed"] == ["trial-2"]
        process.wait(timeout=5)
        assert not alive(process.pid)
        assert reap.read_records(run) == []
    finally:
        if process.poll() is None:  # pragma: no cover - the reap already did it
            process.kill()
            process.wait(timeout=5)


def test_a_leaked_process_is_visible_to_a_suite_level_check(run: Path) -> None:
    reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({41: ("t", 41)}))
    assert [item.trial_id for item in reap.survivors(run, probe_fn=fake_probe({41: ("t", 41)}))] == ["t1"]
    assert reap.survivors(run, probe_fn=fake_probe({})) == []


def test_a_finished_fake_run_leaves_no_survivors(fake_run: Path) -> None:
    assert reap.survivors(fake_run) == []
    assert reap.read_records(fake_run) == []
