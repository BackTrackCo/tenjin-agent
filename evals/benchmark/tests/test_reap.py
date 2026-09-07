"""Cleanup is the package's job, not a judgment call.

The case these hold to: a benchmark process is killed by identity, never by
name. A cleanup that matches a command line, `pkill -f bin/claude` and its
relatives, also matches an operator's own unrelated sessions, and it has done
so on this repository. So the ledger is the only input, every record is checked
against the live process before a signal, and a spawn that raises still leaves
nothing running.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from evals.benchmark import artifact, reap, runner
from evals.benchmark.tests import support


def fake_probe(table: dict[int, tuple[str, int]]):
    def probe(pid: int) -> tuple[str, int] | None:
        return table.get(pid)

    return probe


class LedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run = Path(tempfile.mkdtemp(prefix="bench1-reap-"))

    def test_a_record_names_the_group_and_its_start_time(self) -> None:
        probe = fake_probe({41: ("Mon Sep  7 10:00:00 2026", 41)})
        record = reap.register(self.run, "t1", 41, "claude", probe_fn=probe)
        self.assertIsNotNone(record)
        self.assertEqual([r.pid for r in reap.read_records(self.run)], [41])
        self.assertEqual(reap.read_records(self.run)[0].started, "Mon Sep  7 10:00:00 2026")

    def test_a_process_that_already_exited_is_not_recorded(self) -> None:
        self.assertIsNone(reap.register(self.run, "t1", 41, "claude", probe_fn=fake_probe({})))
        self.assertEqual(reap.read_records(self.run), [])

    def test_a_child_sharing_our_group_is_refused_rather_than_recorded(self) -> None:
        # Recording it would mean a later reap signals this interpreter's group.
        probe = fake_probe({41: ("Mon Sep  7 10:00:00 2026", os.getpgid(0))})
        with self.assertRaises(reap.ReapError):
            reap.register(self.run, "t1", 41, "claude", probe_fn=probe)

    def test_release_removes_the_record(self) -> None:
        reap.register(self.run, "t1", 41, "claude", probe_fn=fake_probe({41: ("t", 41)}))
        reap.release(self.run, "t1")
        self.assertEqual(reap.read_records(self.run), [])

    def test_a_corrupt_record_is_an_error_rather_than_an_empty_ledger(self) -> None:
        reap.ledger_dir(self.run).mkdir(parents=True)
        (reap.ledger_dir(self.run) / "t1.json").write_text("{", encoding="utf-8")
        with self.assertRaises(reap.ReapError):
            reap.read_records(self.run)


class ReapTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run = Path(tempfile.mkdtemp(prefix="bench1-reap-"))
        self.signals: list[tuple[int, int]] = []

    def signaller(self, pgid: int, sig: int) -> None:
        self.signals.append((pgid, sig))

    def record(self, trial: str, pid: int, started: str = "Mon Sep  7 10:00:00 2026") -> None:
        reap.register(self.run, trial, pid, "claude", probe_fn=fake_probe({pid: (started, pid)}))

    def test_a_live_recorded_group_is_signalled_and_its_record_cleared(self) -> None:
        self.record("t1", 41)
        table = {41: ("Mon Sep  7 10:00:00 2026", 41)}
        report = reap.reap(self.run, probe_fn=fake_probe(table), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual(report["killed"], ["t1"])
        self.assertEqual(self.signals, [(41, signal.SIGTERM), (41, signal.SIGKILL)])
        self.assertEqual(reap.read_records(self.run), [])

    def test_a_group_that_dies_on_the_first_signal_is_not_killed_twice(self) -> None:
        self.record("t1", 41)
        table = {41: ("Mon Sep  7 10:00:00 2026", 41)}

        def signaller(pgid: int, sig: int) -> None:
            self.signals.append((pgid, sig))
            table.pop(pgid, None)

        reap.reap(self.run, probe_fn=fake_probe(table), signal_fn=signaller, sleep=lambda _: None)
        self.assertEqual(self.signals, [(41, signal.SIGTERM)])

    def test_an_exited_process_is_reported_gone_and_never_signalled(self) -> None:
        self.record("t1", 41)
        report = reap.reap(self.run, probe_fn=fake_probe({}), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual(report["outcomes"], {"t1": "gone"})
        self.assertEqual(self.signals, [])

    def test_a_recycled_pid_is_refused_because_it_is_now_a_stranger(self) -> None:
        # The exact accident this module exists to prevent: the number is ours,
        # the process is not.
        self.record("t1", 41, started="Mon Sep  7 10:00:00 2026")
        table = {41: ("Mon Sep  7 18:35:00 2026", 41)}
        report = reap.reap(self.run, probe_fn=fake_probe(table), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual(report["refused"], ["t1"])
        self.assertEqual(self.signals, [])
        self.assertEqual(reap.read_records(self.run), [])

    def test_a_process_that_left_its_group_is_refused(self) -> None:
        self.record("t1", 41)
        table = {41: ("Mon Sep  7 10:00:00 2026", 999)}
        report = reap.reap(self.run, probe_fn=fake_probe(table), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual(report["refused"], ["t1"])
        self.assertEqual(self.signals, [])

    def test_it_never_signals_a_group_it_did_not_record(self) -> None:
        self.record("t1", 41)
        table = {41: ("Mon Sep  7 10:00:00 2026", 41), 77: ("Mon Sep  7 10:00:00 2026", 77)}
        reap.reap(self.run, probe_fn=fake_probe(table), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual({pgid for pgid, _ in self.signals}, {41})

    def test_an_empty_ledger_signals_nothing(self) -> None:
        report = reap.reap(self.run, probe_fn=fake_probe({}), signal_fn=self.signaller, sleep=lambda _: None)
        self.assertEqual(report["outcomes"], {})
        self.assertEqual(self.signals, [])


class NoNameMatchingTest(unittest.TestCase):
    def test_no_module_can_kill_by_matching_a_process_name(self) -> None:
        # A name match is what reached an operator's unrelated sessions, so the
        # ban is executable rather than remembered. Prose may name the mistake:
        # only real code is searched, docstrings and comments excluded, and this
        # module is skipped because the pattern it looks for is written here.
        import ast

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
        self.assertEqual(offenders, [], "a name-matching kill is never the cleanup")


class SpawnLeavesNothingRunningTest(unittest.TestCase):
    """The real thing: a spawned process, a real signal, a real ledger."""

    def setUp(self) -> None:
        self.run = Path(tempfile.mkdtemp(prefix="bench1-spawn-"))
        fixture = Path(tempfile.mkdtemp(prefix="bench1-fixture-")) / "repo"
        fixture.mkdir()
        (fixture / "TASK.md").write_text("nothing\n", encoding="utf-8")
        self.roots = artifact.create(self.run, "trial-1", fixture)

    def launch(self, seconds: int) -> object:
        from evals.benchmark import executor

        return executor.Launch(
            argv=[sys.executable, "-c", f"import time; time.sleep({seconds})"],
            cwd=self.roots.repo,
            root_session_id="s1",
        )

    def alive(self, pid: int) -> bool:
        return reap.probe(pid) is not None

    def test_a_timeout_kills_the_group_and_clears_its_record(self) -> None:
        completed = runner.process_spawn(self.launch(30), self.roots, timeout_s=0.4)
        self.assertTrue(completed.timed_out)
        self.assertEqual(reap.read_records(self.run), [])
        self.assertEqual(reap.survivors(self.run), [])

    def test_an_interrupt_on_the_way_out_still_leaves_nothing_running(self) -> None:
        # The leak that made a person reach for a name match: an exception
        # between the spawn and the wait. The finally-path owns it.
        pids: list[int] = []
        real_communicate = subprocess.Popen.communicate

        def explode(self_process, *args, **kwargs):  # type: ignore[no-untyped-def]
            pids.append(self_process.pid)
            raise KeyboardInterrupt("operator stopped the run")

        subprocess.Popen.communicate = explode  # type: ignore[assignment]
        try:
            with self.assertRaises(KeyboardInterrupt):
                runner.process_spawn(self.launch(30), self.roots, timeout_s=30)
        finally:
            subprocess.Popen.communicate = real_communicate  # type: ignore[assignment]

        self.assertEqual(len(pids), 1)
        deadline = time.monotonic() + 5
        while self.alive(pids[0]) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(self.alive(pids[0]), "the interrupted spawn left a process running")
        self.assertEqual(reap.read_records(self.run), [])

    def test_cleanup_reaps_a_recorded_group_left_behind(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
        try:
            reap.register(self.run, "trial-2", process.pid, sys.executable)
            report = reap.reap(self.run, grace_s=0.2)
            self.assertEqual(report["killed"], ["trial-2"])
            process.wait(timeout=5)
            self.assertFalse(self.alive(process.pid))
            self.assertEqual(reap.read_records(self.run), [])
        finally:
            if process.poll() is None:  # pragma: no cover - the reap already did it
                process.kill()
                process.wait(timeout=5)


class SurvivorsTest(unittest.TestCase):
    def test_a_leaked_process_is_visible_to_a_suite_level_check(self) -> None:
        run = Path(tempfile.mkdtemp(prefix="bench1-survivors-"))
        reap.register(run, "t1", 41, "claude", probe_fn=fake_probe({41: ("t", 41)}))
        alive = reap.survivors(run, probe_fn=fake_probe({41: ("t", 41)}))
        self.assertEqual([record.trial_id for record in alive], ["t1"])
        self.assertEqual(reap.survivors(run, probe_fn=fake_probe({})), [])

    def test_a_finished_fake_run_leaves_no_survivors(self) -> None:
        from evals.benchmark import cli

        with tempfile.TemporaryDirectory(prefix="bench1-clean-") as directory:
            run = Path(directory) / "run"
            cli.fake_run(run)
            self.assertEqual(reap.survivors(run), [])
            self.assertEqual(reap.read_records(run), [])


if __name__ == "__main__":
    unittest.main()
