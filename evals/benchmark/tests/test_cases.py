"""Case records for the search-intent experiment: read after settlement, one per fire, replayed through a fake CLI."""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals.benchmark import cases, cli, records, tenjin_arm
from evals.benchmark.tests import support

FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
SECRET = "bench1-cases-shelf-secret-0123456789abcdef"


class CasesCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"
        with contextlib.redirect_stdout(io.StringIO()):
            cli.fake_run(self.run_dir)
        self.records_dir = self.run_dir / "records"
        self.trials = sorted(path.name.removesuffix(".json") for path in self.records_dir.glob("*.json") if ".partial." not in path.name)
        self.source_dir = self.dir / "source"
        (self.source_dir / "hooks").mkdir(parents=True)
        for name in tenjin_arm.BUNDLES:
            (self.source_dir / "hooks" / name).write_text("// placeholder\n", encoding="utf-8")
        (self.source_dir / "config.json").write_text(json.dumps({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example", "shelfBypassSecret": SECRET}), encoding="utf-8")
        self.source = tenjin_arm.load_source(self.source_dir)
        patcher = mock.patch.object(tenjin_arm, "SEARCH_ARGV", lambda query: [sys.executable, FAKE_CLI, *tenjin_arm.search_argv(query)[1:]])
        patcher.start()
        self.addCleanup(patcher.stop)

    def record(self, trial_id: str) -> dict:
        return json.loads((self.records_dir / f"{trial_id}.json").read_text(encoding="utf-8"))

    def write_ledger(self, trial_id: str, session: str, agent: str, *, wal: bool = False) -> Path:
        data = self.run_dir / "trials" / trial_id / "data"
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

    def seeded(self, trial_id: str, piece_id: str) -> None:
        record = self.record(trial_id)
        seed = {"lesson": "fam", "title": "The lesson", "nonce": "20260908T000000Z-0badf00d", "key_hashes": ["abcd"], "keys": 1, "shelf_origin": "team-shelf.example", "piece_id": piece_id, "published": True, "probe": None, "deleted": True, "delete_error": None}
        record["isolation"] = {**record["isolation"], "seed": [seed]}
        records.validate(record)
        (self.records_dir / f"{trial_id}.json").write_text(json.dumps(record), encoding="utf-8")

    def write_snapshot(self, trial_id: str, entries: list[dict], seeded_ids: list[str]) -> Path:
        """The shortlist the arm's stop path would have left in the trial's output."""
        output = self.run_dir / "trials" / trial_id / "output"
        output.mkdir(parents=True, exist_ok=True)
        path = output / tenjin_arm.SHORTLIST_FILE
        payload = {"trial_id": trial_id, "phase": None, "at": "2026-09-09T00:00:00Z", "shelf_origin": "team-shelf.example", "limit": 10, "seeded_piece_ids": seeded_ids, "entries": entries}
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def snapshot_entry(self, question: str, key: str | None, candidates: list[dict]) -> dict:
        return {
            "question": question,
            "question_key": key,
            "fire_id": "f1",
            "fire_event": "prompt",
            "hook_arm": "prompt",
            "at": "2026-09-09T00:00:00Z",
            "search": {"exit": 0, "search_id": "search-in-run", "candidates": candidates, "error": None, "limit": 10, "post_floor": True},
        }


class ExportTest(CasesCase):
    def test_one_record_per_fire_with_a_question_or_a_key_replayed_and_seeded_marked_apart(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        _harness, session, agent = record["actors"][0]["key"]
        self.write_ledger(trial, session, agent)
        self.seeded(trial, "piece-seeded")
        (self.source_dir / "search-items.json").write_text(
            json.dumps([
                {"resourceId": "piece-seeded", "title": "The lesson", "url": "https://team-shelf.example/p/piece-seeded", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1"},
                {"resourceId": "piece-real", "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False},
            ]),
            encoding="utf-8",
        )
        out = self.dir / "cases.jsonl"
        summary = cli.do_cases(self.run_dir, self.source_dir, out)
        self.assertEqual((summary["cases"], summary["replayed"], summary["seeded_candidates"]), (2, 1, 1))
        rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        prompt, failure = rows
        nonce = json.loads((self.run_dir / "manifest.json").read_text(encoding="utf-8"))["nonce"]
        self.assertEqual(prompt["case_id"], f"{nonce}:{trial}:f1")
        self.assertEqual(
            sorted(prompt),
            ["attempt", "baseline", "case_id", "context_packet", "corpus_snapshot", "human_label", "labels_schema", "method", "prompt", "replay", "revisions", "seeded_piece_ids", "source", "trigger"],
        )
        self.assertEqual((prompt["trigger"], prompt["prompt"]["text"], prompt["method"], prompt["human_label"]), ("prompt", "How do I run one vitest file here?", "baseline", None))
        self.assertEqual(prompt["baseline"]["rank1_title"], "The convention piece")
        self.assertEqual((prompt["baseline"]["hit"], prompt["baseline"]["delivered_piece_id"], prompt["baseline"]["delivered_seeded"]), (True, "piece-real", False))
        self.assertEqual([(c["rank"], c["id"], c["seeded"], c["strong"], c["confidence"], c["corroborated"], c["calibration"]) for c in prompt["replay"]["candidates"]],
                         [(1, "piece-seeded", True, True, 0.9, True, "hybrid-v1"), (2, "piece-real", False, False, None, None, None)])
        self.assertEqual((prompt["replay"]["post_floor"], prompt["replay"]["limit"], prompt["replay"]["search_id"]), (True, 10, "search-1"))
        # No trial snapshot on disk, so the shortlist is this command's own search.
        self.assertEqual((prompt["replay"]["source"], summary["from_snapshot"]), ("post_run_replay", 0))
        self.assertRegex(prompt["corpus_snapshot"]["replayed_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(prompt["corpus_snapshot"]["shelf_origin"], "team-shelf.example")
        self.assertEqual(prompt["revisions"]["run_nonce"], nonce)
        self.assertEqual(prompt["seeded_piece_ids"], ["piece-seeded"])
        self.assertIsNotNone(prompt["attempt"]["tokens"])
        self.assertEqual((failure["trigger"], failure["prompt"]["text"], failure["prompt"]["question_key"]), ("failure", None, "502b90852a1505e3"))
        situation = failure["context_packet"]["situation"]
        self.assertEqual((situation["command_head"], situation["command"], situation["key_kind"]), ("pnpm", "pnpm exec vitest run tests/actor.test.mjs", "sig_v1_test"))
        self.assertEqual(situation["source"]["error_line"], "pairings.error_line")
        self.assertIn("skipped", failure["replay"])
        text = out.read_text(encoding="utf-8")
        self.assertNotIn(SECRET, text)
        self.assertIn("[secret]", text)
        self.assertNotIn("/Users/operator", text)

    def test_the_trials_own_snapshot_is_preferred_and_the_record_says_which_source_it_came_from(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        _harness, session, agent = record["actors"][0]["key"]
        self.write_ledger(trial, session, agent)
        self.seeded(trial, "piece-seeded")
        self.write_snapshot(
            trial,
            [
                self.snapshot_entry(
                    "How do I run one vitest file here?",
                    None,
                    [
                        {"id": "piece-seeded", "rank": 1, "title": "The lesson", "url": "https://team-shelf.example/p/piece-seeded", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1", "score": None, "match_reasons": None},
                        {"id": "piece-real", "rank": 2, "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False, "confidence": None, "corroborated": None, "calibration": None, "score": None, "match_reasons": None},
                    ],
                )
            ],
            ["piece-seeded"],
        )
        out = self.dir / "cases.jsonl"
        with mock.patch.object(tenjin_arm, "SEARCH_ARGV", side_effect=AssertionError("a case with a snapshot is never replayed")):
            summary = cli.do_cases(self.run_dir, self.source_dir, out)
        self.assertEqual((summary["from_snapshot"], summary["replayed"], summary["seeded_candidates"]), (1, 1, 1))
        prompt, failure = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        self.assertEqual((prompt["replay"]["source"], prompt["replay"]["search_id"]), ("in_run_snapshot", "search-in-run"))
        # The snapshot's own time, not the export's: it says when the shelf was read.
        self.assertEqual(prompt["corpus_snapshot"]["replayed_at"], "2026-09-09T00:00:00Z")
        self.assertEqual((prompt["replay"]["limit"], prompt["replay"]["post_floor"], prompt["replay"]["exit"]), (10, True, 0))
        self.assertEqual([(c["rank"], c["id"], c["seeded"]) for c in prompt["replay"]["candidates"]], [(1, "piece-seeded", True), (2, "piece-real", False)])
        self.assertIn("skipped", failure["replay"])

    def test_the_seeded_flag_comes_from_the_trials_own_seed_list(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        _harness, session, agent = record["actors"][0]["key"]
        self.write_ledger(trial, session, agent)
        # The record says this trial seeded `piece-other`; the snapshot's own header says something else.
        self.seeded(trial, "piece-other")
        self.write_snapshot(
            trial,
            [
                self.snapshot_entry(
                    "How do I run one vitest file here?",
                    None,
                    [{"id": "piece-seeded", "rank": 1, "title": "The lesson", "url": "u", "strong": True}, {"id": "piece-other", "rank": 2, "title": "The other", "url": "u", "strong": False}],
                )
            ],
            ["piece-seeded"],
        )
        out = self.dir / "cases.jsonl"
        with mock.patch.object(tenjin_arm, "SEARCH_ARGV", side_effect=AssertionError("a case with a snapshot is never replayed")):
            summary = cli.do_cases(self.run_dir, self.source_dir, out)
        prompt = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(prompt["seeded_piece_ids"], ["piece-other"])
        self.assertEqual([(c["id"], c["seeded"]) for c in prompt["replay"]["candidates"]], [("piece-seeded", False), ("piece-other", True)])
        self.assertEqual(summary["seeded_candidates"], 1)

    def test_a_snapshot_that_does_not_hold_the_question_falls_back_to_a_replay(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        _harness, session, agent = record["actors"][0]["key"]
        self.write_ledger(trial, session, agent)
        self.write_snapshot(trial, [self.snapshot_entry("a question this trial never asked", None, [])], [])
        (self.source_dir / "search-items.json").write_text(json.dumps([{"resourceId": "piece-real", "title": "The convention piece", "url": "u", "strong": False}]), encoding="utf-8")
        out = self.dir / "cases.jsonl"
        summary = cli.do_cases(self.run_dir, self.source_dir, out)
        prompt = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual((summary["from_snapshot"], prompt["replay"]["source"], prompt["replay"]["search_id"]), (0, "post_run_replay", "search-1"))
        # A file that is not a shortlist at all is a fall back too, never a refusal.
        (self.run_dir / "trials" / trial / "output" / tenjin_arm.SHORTLIST_FILE).write_text("{", encoding="utf-8")
        self.assertEqual(cli.do_cases(self.run_dir, self.source_dir, out)["from_snapshot"], 0)

    def test_a_dry_run_lists_the_cases_and_calls_nothing(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        self.write_ledger(trial, record["actors"][0]["key"][1], record["actors"][0]["key"][2])
        stdout = io.StringIO()
        with mock.patch.object(tenjin_arm, "SEARCH_ARGV", side_effect=AssertionError("a dry run calls nothing")), contextlib.redirect_stdout(stdout):
            code = cli.main(["cases", "--run", str(self.run_dir), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("cases dry run: 2 case(s) across 2 trial(s); nothing replayed, nothing written", stdout.getvalue())
        self.assertIn("failure pnpm", stdout.getvalue())
        self.assertFalse((self.dir / "cases.jsonl").exists())

    def test_a_run_that_is_not_settled_or_a_replay_without_a_source_is_refused(self) -> None:
        trial = self.trials[0]
        record = self.record(trial)
        self.write_ledger(trial, record["actors"][0]["key"][1], record["actors"][0]["key"][2], wal=True)
        with self.assertRaises(cases.CasesError) as caught:
            cli.do_cases(self.run_dir, self.source_dir, self.dir / "x.jsonl")
        self.assertIn("live loop.db WAL", str(caught.exception))
        # A zero-byte WAL, the residue of a reader that opened the ledger without immutable=1, is settled.
        (self.run_dir / "trials" / trial / "data" / "loop.db-wal").write_bytes(b"")
        self.assertEqual(cli.do_cases(self.run_dir, None, None, dry_run=True)["cases"], 2)
        (self.run_dir / "trials" / trial / "data" / "loop.db-wal").unlink()
        with self.assertRaises(cli.CliError):
            cli.do_cases(self.run_dir, None, self.dir / "x.jsonl")
        with self.assertRaises(cli.CliError):
            cli.do_cases(self.run_dir, self.source_dir, None)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = cli.main(["cases", "--run", str(self.dir / "nothing"), "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("the run did not start", stderr.getvalue())

    def test_a_trial_without_a_ledger_yields_no_case(self) -> None:
        summary = cli.do_cases(self.run_dir, self.source_dir, self.dir / "empty.jsonl")
        self.assertEqual((summary["cases"], summary["trials"]), (0, 2))
        self.assertEqual((self.dir / "empty.jsonl").read_text(encoding="utf-8"), "")


if __name__ == "__main__":
    unittest.main()
