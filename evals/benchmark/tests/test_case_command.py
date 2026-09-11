"""Case records for the search-intent experiment: read after settlement, one per fire, replayed through a fake CLI."""

from __future__ import annotations

import contextlib
import io
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Iterator
from unittest import mock

import pytest
from inline_snapshot import snapshot

from evals.benchmark import cases, cli, records, tenjin_arm
from evals.benchmark.tests import support

FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
SECRET = "bench1-cases-shelf-secret-0123456789abcdef"




from evals.benchmark.tests.test_cases import trials, ledger_for


@pytest.fixture
def source_dir(tmp_path: Path) -> Path:
    """A Tenjin source the replay reads: placeholder bundles and one config."""
    source = tmp_path / "source"
    (source / "hooks").mkdir(parents=True)
    for name in tenjin_arm.BUNDLES:
        (source / "hooks" / name).write_text("// placeholder\n", encoding="utf-8")
    (source / "config.json").write_text(
        json.dumps({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example", "shelfBypassSecret": SECRET}),
        encoding="utf-8",
    )
    return source


@pytest.fixture(autouse=True)
def replay_through_the_fake_cli() -> Iterator[None]:
    """Every replay in this module runs `tests/fake_cli.py`, never the real one."""
    with mock.patch.object(tenjin_arm, "SEARCH_ARGV", lambda query: [sys.executable, FAKE_CLI, *tenjin_arm.search_argv(query)[1:]]):
        yield


def test_a_dry_run_lists_the_cases_and_calls_nothing(fake_run: Path, trials: list[str], tmp_path: Path) -> None:
    ledger_for(fake_run, trials[0])
    stdout = io.StringIO()
    with mock.patch.object(tenjin_arm, "SEARCH_ARGV", side_effect=AssertionError("a dry run calls nothing")), contextlib.redirect_stdout(stdout):
        code = cli.main(["cases", "--run", str(fake_run), "--dry-run"])
    assert code == 0
    assert f"cases dry run: 2 case(s) across {len(trials)} trial(s); nothing replayed, nothing written" in stdout.getvalue()
    assert "failure pnpm" in stdout.getvalue()
    assert not (tmp_path / "cases.jsonl").exists()


def test_a_run_that_is_not_settled_or_a_replay_without_a_source_is_refused(
    fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path
) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial, wal=True)
    with pytest.raises(cases.CasesError) as caught:
        cli.do_cases(fake_run, source_dir, tmp_path / "x.jsonl")
    assert "live loop.db WAL" in str(caught.value)
    # A zero-byte WAL, the residue of a reader that opened the ledger without immutable=1, is settled.
    wal = fake_run / "trials" / trial / "data" / "loop.db-wal"
    wal.write_bytes(b"")
    assert cli.do_cases(fake_run, None, None, dry_run=True)["cases"] == 2
    wal.unlink()
    with pytest.raises(cli.CliError):
        cli.do_cases(fake_run, None, tmp_path / "x.jsonl")
    with pytest.raises(cli.CliError):
        cli.do_cases(fake_run, source_dir, None)
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        code = cli.main(["cases", "--run", str(tmp_path / "nothing"), "--dry-run"])
    assert code == 2
    assert "the run did not start" in stderr.getvalue()
