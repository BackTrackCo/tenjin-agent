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


@pytest.fixture
def trials(fake_run: Path) -> list[str]:
    return sorted(path.name.removesuffix(".json") for path in (fake_run / "records").glob("*.json") if ".partial." not in path.name)


def read_record(run_dir: Path, trial_id: str) -> dict:
    return json.loads((run_dir / "records" / f"{trial_id}.json").read_text(encoding="utf-8"))


def write_ledger(run_dir: Path, trial_id: str, session: str, agent: str, *, wal: bool = False) -> Path:
    """One prompt fire with a question, one keyed tool failure, and one skipped context fire."""
    data = run_dir / "trials" / trial_id / "data"
    data.mkdir(parents=True, exist_ok=True)
    path = data / "loop.db"
    db = sqlite3.connect(path)
    db.executescript(support.loop_ddl())
    rows = [
        ("f1", 1, "prompt", "prompt", "hit", None, "How do I run one vitest file here?", "team:piece-real"),
        ("f2", 2, "failure", "tool.after", "miss", "502b90852a1505e3", None, None),
        ("f3", 3, "context", "tool.before", "skipped", None, None, None),
    ]
    for fire_id, at, arm, event, reason, key, question, delivered in rows:
        db.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, cwd, wait, deadline_ms, elapsed_ms, reason, question_key, question, delivered)"
            " VALUES (?, ?, ?, ?, ?, 'claude', ?, 'p1', '/Users/operator/run/repo', 'sync', 1000, 12, ?, ?, ?, ?)",
            (fire_id, at, session, agent, arm, event, reason, key, question, delivered),
        )
    db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title, url, form, calibration) VALUES ('f1', 0, 'team', 'ok', 'hit', 40, 'search-9', 'The convention piece', 'https://team-shelf.example/p/piece-real', 'inline', 'hybrid-v1')")
    db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id) VALUES ('f2', 0, 'keys', 'ok', 'no-answer', 30, NULL)")
    db.execute(
        "INSERT INTO pairings (uid, at, session, project, machine, kind, key, cmd_head, cmd, error_line, error_files, scope, status)"
        " VALUES ('u1', 2, ?, 'proj', 'm', 'sig_v1_test', '502b90852a1505e3', 'pnpm', 'pnpm exec vitest run tests/actor.test.mjs', ?, '[]', 'project', 'open')",
        (session, f"AssertionError: expected 's1:undefined' to be 's1:root' {SECRET}"),
    )
    db.commit()
    db.close()
    if wal:
        path.with_name("loop.db-wal").write_bytes(b"\x37\x7f\x06\x82" + b"\x00" * 28)
    return path


def ledger_for(run_dir: Path, trial_id: str, **kwargs: bool) -> Path:
    """The ledger keyed on the actor the trial's own record names."""
    _harness, session, agent = read_record(run_dir, trial_id)["actors"][0]["key"]
    return write_ledger(run_dir, trial_id, session, agent, **kwargs)


def seeded(run_dir: Path, trial_id: str, piece_id: str) -> None:
    record = read_record(run_dir, trial_id)
    seed = {"lesson": "fam", "title": "The lesson", "nonce": "20260908T000000Z-0badf00d", "key_hashes": ["abcd"], "keys": 1, "shelf_origin": "team-shelf.example", "piece_id": piece_id, "published": True, "probe": None, "deleted": True, "delete_error": None}
    record["isolation"] = {**record["isolation"], "seed": [seed]}
    records.validate(record)
    (run_dir / "records" / f"{trial_id}.json").write_text(json.dumps(record), encoding="utf-8")


def test_one_record_per_fire_with_a_question_or_a_key_replayed_and_seeded_marked_apart(
    fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path
) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial)
    seeded(fake_run, trial, "piece-seeded")
    (source_dir / "search-items.json").write_text(
        json.dumps([
            {"resourceId": "piece-seeded", "title": "The lesson", "url": "https://team-shelf.example/p/piece-seeded", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1"},
            {"resourceId": "piece-real", "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False},
        ]),
        encoding="utf-8",
    )
    out = tmp_path / "cases.jsonl"
    summary = cli.do_cases(fake_run, source_dir, out)
    assert (summary["cases"], summary["replayed"], summary["seeded_candidates"]) == (2, 1, 1)
    prompt, failure = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    nonce = json.loads((fake_run / "manifest.json").read_text(encoding="utf-8"))["nonce"]
    assert prompt["case_id"] == f"{nonce}:{trial}:f1"
    assert sorted(prompt) == ["attempt", "baseline", "case_id", "context_packet", "corpus_snapshot", "human_label", "labels_schema", "method", "prompt", "replay", "revisions", "seeded_piece_ids", "source", "trigger"]
    assert (prompt["trigger"], prompt["prompt"]["text"], prompt["method"], prompt["human_label"]) == ("prompt", "How do I run one vitest file here?", "baseline", None)
    assert prompt["baseline"]["rank1_title"] == "The convention piece"
    assert (prompt["baseline"]["hit"], prompt["baseline"]["delivered_piece_id"], prompt["baseline"]["delivered_seeded"]) == (True, "piece-real", False)
    assert [(c["rank"], c["id"], c["seeded"], c["strong"], c["confidence"], c["corroborated"], c["calibration"]) for c in prompt["replay"]["candidates"]] == snapshot(
        [
            (1, "piece-seeded", True, True, 0.9, True, "hybrid-v1"),
            (2, "piece-real", False, False, None, None, None),
        ]
    )
    assert (prompt["replay"]["post_floor"], prompt["replay"]["limit"], prompt["replay"]["search_id"]) == (True, 10, "search-1")
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", prompt["corpus_snapshot"]["replayed_at"])
    assert prompt["corpus_snapshot"]["shelf_origin"] == "team-shelf.example"
    assert prompt["revisions"]["run_nonce"] == nonce
    assert prompt["seeded_piece_ids"] == ["piece-seeded"]
    assert prompt["attempt"]["tokens"] is not None
    assert (failure["trigger"], failure["prompt"]["text"], failure["prompt"]["question_key"]) == ("failure", None, "502b90852a1505e3")
    situation = failure["context_packet"]["situation"]
    assert (situation["command_head"], situation["command"], situation["key_kind"]) == ("pnpm", "pnpm exec vitest run tests/actor.test.mjs", "sig_v1_test")
    assert situation["source"]["error_line"] == "pairings.error_line"
    assert "skipped" in failure["replay"]
    text = out.read_text(encoding="utf-8")
    assert SECRET not in text
    assert "[secret]" in text
    assert "/Users/operator" not in text


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


def test_a_trial_without_a_ledger_yields_no_case(fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path) -> None:
    out = tmp_path / "empty.jsonl"
    summary = cli.do_cases(fake_run, source_dir, out)
    # Every trial in the run was read, and none of them held a ledger.
    assert (summary["cases"], summary["trials"]) == (0, len(trials))
    assert out.read_text(encoding="utf-8") == ""
