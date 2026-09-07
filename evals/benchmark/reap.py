"""Deterministic cleanup: kill what this package started, and nothing else.

Every process the benchmark starts gets its own session, so its process group
id equals its pid and killing that group reaches every descendant. This module
writes one record per live group under `<run>/pids/` and removes it when the
process is reaped, so a leftover is a file on disk rather than something a
person has to find with `ps`.

`reap` acts on those records only. It never matches a process name, a binary
path, or a command line: a pattern like `pkill -f bin/claude` also matches the
operator's own editor session, and reaching for one is exactly the accident this
module exists to remove. Before signalling, a record is checked against the live
process: same start time and same group, or the record is dropped unkilled,
because a pid is reused and killing a recycled one kills a stranger.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

LEDGER_DIR = "pids"
# Between the polite signal and the final one. A trial's agent has nothing to
# flush, so this is short; it exists so a process gets to die on its own terms.
GRACE_S = 2.0


class ReapError(RuntimeError):
    pass


@dataclass(frozen=True)
class Record:
    """One live process group this package started."""

    trial_id: str
    pid: int
    pgid: int
    started: str
    argv0: str

    def to_json(self) -> dict[str, Any]:
        return {
            "trial_id": self.trial_id,
            "pid": self.pid,
            "pgid": self.pgid,
            "started": self.started,
            "argv0": self.argv0,
        }

    @staticmethod
    def from_json(payload: dict[str, Any]) -> "Record":
        return Record(
            trial_id=str(payload["trial_id"]),
            pid=int(payload["pid"]),
            pgid=int(payload["pgid"]),
            started=str(payload["started"]),
            argv0=str(payload["argv0"]),
        )


# The seam every test replaces. Returning None means "no such process".
Probe = Callable[[int], tuple[str, int] | None]
Signaller = Callable[[int, int], None]


def probe(pid: int) -> tuple[str, int] | None:
    """The live process's start time and group, or None if it is gone.

    `lstart` is the identity that survives pid reuse: a recycled pid has a
    later start time, and comparing it is what keeps this module from killing
    a stranger that inherited the number.

    A zombie reads as gone. It is already dead and waiting to be collected by
    its parent, and signalling its group is refused by the kernel on macOS, so
    treating it as live would turn an ordinary exit into an error.
    """
    completed = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart=,pgid=,state="],
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    line = completed.stdout.strip()
    if completed.returncode != 0 or not line:
        return None
    rest, _, state = line.rpartition(" ")
    started, _, group = rest.rpartition(" ")
    if state.startswith("Z"):
        return None
    try:
        return started.strip(), int(group)
    except ValueError:
        return None


def ledger_dir(run_dir: Path) -> Path:
    return run_dir / LEDGER_DIR


def record_path(run_dir: Path, trial_id: str) -> Path:
    return ledger_dir(run_dir) / f"{trial_id}.json"


def register(run_dir: Path, trial_id: str, pid: int, argv0: str, probe_fn: Probe = probe) -> Record | None:
    """Record a live group. A process that is already gone is not recorded."""
    live = probe_fn(pid)
    if live is None:
        return None
    started, pgid = live
    if pgid == os.getpgid(0):
        # The child is meant to lead its own session. Sharing ours means a kill
        # would reach this interpreter and everything else in the group.
        raise ReapError(f"refusing to record pid {pid}: it shares this process group")
    record = Record(trial_id=trial_id, pid=pid, pgid=pgid, started=started, argv0=argv0)
    directory = ledger_dir(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = record_path(run_dir, trial_id)
    partial = path.with_suffix(".partial")
    partial.write_text(json.dumps(record.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    partial.replace(path)
    return record


def release(run_dir: Path, trial_id: str) -> None:
    """The process was reaped by its own spawn call; the record is spent."""
    record_path(run_dir, trial_id).unlink(missing_ok=True)


def read_records(run_dir: Path) -> list[Record]:
    records: list[Record] = []
    directory = ledger_dir(run_dir)
    if not directory.is_dir():
        return records
    for path in sorted(directory.glob("*.json")):
        try:
            records.append(Record.from_json(json.loads(path.read_text(encoding="utf-8"))))
        except (json.JSONDecodeError, KeyError, ValueError) as error:
            raise ReapError(f"{path.name} is not a process record: {error}") from error
    return records


def _verify(record: Record, probe_fn: Probe) -> str:
    """Why this record may or may not be signalled. One word, from a fixed set."""
    live = probe_fn(record.pid)
    if live is None:
        return "gone"
    started, pgid = live
    if started != record.started:
        return "recycled"
    if pgid != record.pgid:
        return "regrouped"
    if record.pgid == os.getpgid(0):
        return "our_group"
    return "kill"


def _signal(signal_fn: Signaller, pgid: int, sig: int, outcomes: dict[str, str], record: Record) -> bool:
    """Send one signal. A group that is already gone is not an error.

    `ProcessLookupError` means it exited between the check and the signal, and
    macOS answers a group whose last member is a zombie with `PermissionError`.
    Both are recorded as outcomes rather than raised, because a cleanup that
    throws is a cleanup someone finishes by hand.
    """
    try:
        signal_fn(pgid, sig)
    except ProcessLookupError:
        outcomes[record.trial_id] = "gone"
        return False
    except PermissionError:
        outcomes[record.trial_id] = "denied"
        return False
    return True


def reap(
    run_dir: Path,
    probe_fn: Probe = probe,
    signal_fn: Signaller = os.killpg,
    sleep: Callable[[float], None] = time.sleep,
    grace_s: float = GRACE_S,
    records: Iterable[Record] | None = None,
) -> dict[str, Any]:
    """Kill every recorded group that is still the process we recorded.

    Verdicts: `killed`, `gone` (already exited), `recycled` (the pid belongs to
    someone else now), `regrouped` (it left the group we recorded), `our_group`
    (signalling it would reach this interpreter), and `denied` (the kernel
    refused). Only `killed` sends a signal that lands, and the record is removed
    either way, because a record that cannot be acted on is a record nobody
    should act on later.
    """
    outcomes: dict[str, str] = {}
    pending: list[Record] = []
    for record in read_records(run_dir) if records is None else list(records):
        verdict = _verify(record, probe_fn)
        outcomes[record.trial_id] = verdict
        if verdict != "kill":
            release(run_dir, record.trial_id)
            continue
        if _signal(signal_fn, record.pgid, signal.SIGTERM, outcomes, record):
            pending.append(record)
        else:
            release(run_dir, record.trial_id)

    if pending:
        sleep(grace_s)
    for record in pending:
        if _verify(record, probe_fn) == "kill":
            if not _signal(signal_fn, record.pgid, signal.SIGKILL, outcomes, record):
                release(run_dir, record.trial_id)
                continue
        outcomes[record.trial_id] = "killed"
        release(run_dir, record.trial_id)

    return {
        "run": str(run_dir),
        "outcomes": outcomes,
        "killed": sorted(trial for trial, verdict in outcomes.items() if verdict == "killed"),
        "refused": sorted(
            trial for trial, verdict in outcomes.items() if verdict in ("recycled", "regrouped", "our_group", "denied")
        ),
    }


def survivors(run_dir: Path, probe_fn: Probe = probe) -> list[Record]:
    """Recorded groups still alive. A test that leaks a process fails on this."""
    return [record for record in read_records(run_dir) if _verify(record, probe_fn) == "kill"]
