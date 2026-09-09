"""The corpus reset, its guard, and the automated lane the attestation opens.

Every case runs against a fake provider, which is the point of the seam: the
branches the plan names do not exist yet, and a guard that could only be tested
against a live project would be tested after it was needed.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import artifact, cli, corpus, executor, manifest as manifest_module, records, report, runner
from evals.benchmark.corpus import CorpusError
from evals.benchmark.executor import ExecutorSpec
from evals.benchmark.tests import support

LIVE = "live_only_for_the_corpus_test"
ORIGIN = "bench.example"
PROJECT = "weathered-paper-24312028"
BRANCH = "br-bench-child"
PARENT = "br-bench-parent"
CORPUS = {"provider": "neon", "project_id": PROJECT, "branch_id": BRANCH, "parent_id": PARENT, "origin": ORIGIN}
# What the provider says the target is. The guard reads this, never the manifest.
ROW = {"id": BRANCH, "name": "bench", "default": False, "protected": False, "parent_id": PARENT}


class FakeApi:
    """The provider seam, recorded call by call."""

    def __init__(self, row: dict | Exception | None = None, reset_error: Exception | None = None) -> None:
        self.row = ROW if row is None else row
        self.reset_error = reset_error
        self.calls: list[tuple] = []

    def branch(self, project_id: str, branch_id: str) -> dict:
        self.calls.append(("branch", project_id, branch_id))
        if isinstance(self.row, Exception):
            raise self.row
        return self.row

    def reset_to_parent(self, project_id: str, branch_id: str, parent_id: str) -> None:
        self.calls.append(("reset", project_id, branch_id, parent_id))
        if self.reset_error is not None:
            raise self.reset_error


def parsed(**overrides: str) -> corpus.Corpus:
    return corpus.parse({**CORPUS, **overrides})


class CorpusConfigTest(unittest.TestCase):
    def test_a_corpus_block_parses_into_the_ids_a_reset_needs(self) -> None:
        config = parsed()
        self.assertEqual((config.project_id, config.branch_id, config.parent_id), (PROJECT, BRANCH, PARENT))
        self.assertEqual(config.origins, (ORIGIN, corpus.API_ORIGIN))

    def test_a_malformed_corpus_block_is_refused_before_anything_is_spent(self) -> None:
        cases = {
            "corpus_provider": {"provider": "postgres"},
            "corpus_shape": {"branch_id": "br bench"},
        }
        for code, override in cases.items():
            with self.subTest(code), self.assertRaises(CorpusError) as caught:
                parsed(**override)
            self.assertEqual(caught.exception.code, code)
        for missing in sorted(corpus.CORPUS_KEYS):
            with self.subTest(missing), self.assertRaises(CorpusError) as caught:
                corpus.parse({key: value for key, value in CORPUS.items() if key != missing})
            self.assertEqual(caught.exception.code, "corpus_shape")

    def test_a_branch_that_is_its_own_parent_is_not_a_reset(self) -> None:
        with self.assertRaises(CorpusError) as caught:
            parsed(parent_id=BRANCH)
        self.assertEqual(caught.exception.code, "corpus_shape")

    def test_a_manifest_carries_the_corpus_through_load_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            written = support.synthetic_manifest(Path(tmp), corpus=CORPUS)
            loaded = manifest_module.load(written.path)
            self.assertEqual(loaded.corpus, parsed())
            broken = json.loads(written.path.read_text(encoding="utf-8"))
            broken["corpus"] = {**CORPUS, "provider": "sqlite"}
            written.path.write_text(json.dumps(broken), encoding="utf-8")
            with self.assertRaises(manifest_module.ManifestError):
                manifest_module.load(written.path)

    def test_a_manifest_without_a_corpus_resets_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(manifest_module.load(support.synthetic_manifest(Path(tmp)).path).corpus)


class GuardTest(unittest.TestCase):
    """A reset names a branch, so every refusal is about the branch."""

    def refuse(self, row: dict, code: str) -> None:
        with self.assertRaises(CorpusError) as caught:
            corpus.guard(parsed(), row)
        self.assertEqual(caught.exception.code, code)

    def test_the_branch_the_manifest_names_is_reset(self) -> None:
        corpus.guard(parsed(), ROW)

    def test_a_default_branch_is_never_reset(self) -> None:
        self.refuse({**ROW, "default": True}, "default_branch")
        # The field the newer API renamed. A guard that reads one name only
        # would wave a default branch through on the other.
        self.refuse({**ROW, "primary": True}, "default_branch")

    def test_a_protected_branch_is_never_reset(self) -> None:
        self.refuse({**ROW, "protected": True}, "protected_branch")

    def test_a_branch_whose_id_is_not_the_manifests_is_never_reset(self) -> None:
        self.refuse({**ROW, "id": "br-someone-elses"}, "branch_mismatch")
        self.refuse({}, "branch_unreadable")

    def test_a_branch_whose_parent_is_not_the_manifests_is_never_reset(self) -> None:
        # The parent is the source of the restore, so an unexpected one fills
        # the corpus with rows no record accounts for.
        self.refuse({**ROW, "parent_id": "br-somewhere-else"}, "parent_mismatch")
        self.refuse({**ROW, "parent_id": None}, "parent_mismatch")

    def test_the_team_shelfs_own_main_is_refused_as_a_target(self) -> None:
        # The project this runs in holds the team's knowledge. Measured
        # 2026-09-09: its `main` is the default branch and is unprotected, so
        # the default rule is the one that catches it.
        config = corpus.parse({**CORPUS, "branch_id": "br-dry-sound-av487ewe"})
        with self.assertRaises(CorpusError) as caught:
            corpus.guard(config, {"id": "br-dry-sound-av487ewe", "default": True, "protected": False, "parent_id": PARENT})
        self.assertEqual(caught.exception.code, "default_branch")


class ResetTest(unittest.TestCase):
    def test_a_reset_reads_the_branch_first_and_stamps_what_it_reset(self) -> None:
        api = FakeApi()
        stamp = corpus.reset(parsed(), api, now=lambda: "2026-09-09T00:00:00Z")
        self.assertEqual(api.calls, [("branch", PROJECT, BRANCH), ("reset", PROJECT, BRANCH, PARENT)])
        self.assertEqual(
            (stamp.project_id, stamp.branch_id, stamp.parent_id, stamp.origin, stamp.reset_at),
            (PROJECT, BRANCH, PARENT, ORIGIN, "2026-09-09T00:00:00Z"),
        )
        self.assertEqual(stamp.api_origin, corpus.API_ORIGIN)

    def test_a_refused_guard_resets_nothing(self) -> None:
        api = FakeApi(row={**ROW, "protected": True})
        with self.assertRaises(CorpusError):
            corpus.reset(parsed(), api)
        self.assertEqual(api.calls, [("branch", PROJECT, BRANCH)])

    def test_a_failed_reset_and_an_unreachable_provider_both_raise(self) -> None:
        with self.assertRaises(CorpusError) as caught:
            corpus.reset(parsed(), FakeApi(reset_error=CorpusError("reset_failed", "the operation ended failed")))
        self.assertEqual(caught.exception.code, "reset_failed")
        with self.assertRaises(CorpusError) as caught:
            corpus.reset(parsed(), FakeApi(row=CorpusError("api_unreachable", "no answer")))
        self.assertEqual(caught.exception.code, "api_unreachable")


class HttpApiTest(unittest.TestCase):
    """The Neon implementation's own logic, short of the socket."""

    def api(self, answers: list[dict]) -> corpus.HttpApi:
        client = corpus.HttpApi(api_key="k", poll_interval_s=0.0, poll_cap_s=0.0, sleep=lambda _seconds: None)
        object.__setattr__(client, "_call", lambda *args, **kwargs: answers.pop(0))
        return client

    def test_a_missing_api_key_refuses_before_the_first_call(self) -> None:
        with self.assertRaises(CorpusError) as caught:
            corpus.HttpApi.from_env({})
        self.assertEqual(caught.exception.code, "api_key_missing")
        self.assertEqual(corpus.HttpApi.from_env({corpus.API_KEY_VAR: "k"}).api_key, "k")

    def test_a_started_reset_is_not_a_finished_one(self) -> None:
        client = self.api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "finished"}}])
        client.reset_to_parent(PROJECT, BRANCH, PARENT)
        failing = self.api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "failed"}}])
        with self.assertRaises(CorpusError) as caught:
            failing.reset_to_parent(PROJECT, BRANCH, PARENT)
        self.assertEqual(caught.exception.code, "reset_failed")

    def test_an_operation_that_never_finishes_ends_the_run(self) -> None:
        client = self.api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "running"}}])
        with self.assertRaises(CorpusError) as caught:
            client.reset_to_parent(PROJECT, BRANCH, PARENT)
        self.assertEqual(caught.exception.code, "reset_timeout")

    def test_a_branch_response_without_a_branch_is_refused(self) -> None:
        with self.assertRaises(CorpusError) as caught:
            self.api([{"nothing": True}]).branch(PROJECT, BRANCH)
        self.assertEqual(caught.exception.code, "branch_unreadable")


class LiveLaneTest(unittest.TestCase):
    """`--automated` end to end: reset, attest, publish, and every refusal on the way."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.out = self.dir / "run"
        executor.REGISTRY[LIVE] = ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
        )
        self.addCleanup(executor.REGISTRY.pop, LIVE)
        self.manifest = support.synthetic_manifest(self.dir, executor_name=LIVE, live=True, corpus=CORPUS).path
        self.plain = support.synthetic_manifest(self.dir / "plain", executor_name=LIVE, live=True).path
        self.runtime = runner.Runtime(spawn=support.fake_spawn(), settle_cap_s=0.0)
        self.environ = {"CI": "1", "GITHUB_ACTIONS": "true"}
        support.patch_live_gates(self)

    def attestation(self, origins: tuple[str, ...] = ("api.provider.example", ORIGIN, corpus.API_ORIGIN)) -> Path:
        path = self.dir / f"attestation-{len(origins)}-{abs(hash(origins))}.json"
        path.write_text(
            json.dumps(
                {
                    "kind": "container",
                    "instance_id": "bench1-corpus-01",
                    "image": "ghcr.io/example/bench1@sha256:0000",
                    "fresh_roots": True,
                    "wallet_present": False,
                    "credential_seam": "ANTHROPIC_API_KEY",
                    "network_allowlist": list(origins),
                }
            ),
            encoding="utf-8",
        )
        return path

    def launch(self, api: FakeApi | None = None, **kwargs) -> dict:
        return cli.live_run(
            self.out,
            self.manifest,
            kwargs.pop("attestation_path", self.attestation()),
            automated=kwargs.pop("automated", True),
            environ=kwargs.pop("environ", self.environ),
            runtime=self.runtime,
            corpus_api=FakeApi() if api is None else api,
            **kwargs,
        )

    def test_an_automated_attested_run_resets_the_corpus_and_publishes(self) -> None:
        api = FakeApi()
        payload = self.launch(api)
        self.assertEqual(api.calls, [("branch", PROJECT, BRANCH), ("reset", PROJECT, BRANCH, PARENT)])
        self.assertEqual(payload["corpus"]["branch_id"], BRANCH)
        published = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual((published["publishable"], published["isolation"], published["automated"]), (True, "attested", True))
        self.assertEqual(published["corpus"]["project_id"], PROJECT)
        self.assertEqual(published["corpus"]["parent_id"], PARENT)
        report.guard(published)
        self.assertIn(f"corpus neon project {PROJECT}", report.render(published))
        for path in sorted((self.out / "records").glob("*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            records.validate(record)
            self.assertEqual(record["isolation"]["corpus"]["branch_id"], BRANCH)
            self.assertEqual(record["isolation"]["automated"], True)
            self.assertEqual(record["isolation"]["publishable"], True)

    def test_the_reset_happens_before_the_first_trial(self) -> None:
        api = FakeApi()
        order: list[str] = []

        def spawn(launch, roots, timeout_s):
            order.append("trial")
            return support.fake_spawn()(launch, roots, timeout_s)

        self.runtime = runner.Runtime(spawn=spawn, settle_cap_s=0.0)
        real_reset = corpus.reset

        def watched(*args, **kwargs):
            order.append("reset")
            return real_reset(*args, **kwargs)

        corpus.reset = watched  # type: ignore[assignment]
        try:
            self.launch(api)
        finally:
            corpus.reset = real_reset  # type: ignore[assignment]
        self.assertEqual(order[0], "reset")
        self.assertEqual(order.count("reset"), 1)
        self.assertGreater(order.count("trial"), 0)

    def test_a_reset_that_fails_refuses_the_run_before_any_root_exists(self) -> None:
        for api in (FakeApi(row={**ROW, "default": True}), FakeApi(reset_error=CorpusError("reset_failed", "operation failed"))):
            with self.subTest(api.row), self.assertRaises(CorpusError):
                self.launch(api)
            self.assertFalse((self.out / "trials").exists())
            self.assertFalse((self.out / "records").exists())

    def test_an_attestation_that_does_not_name_the_bench_origin_is_refused(self) -> None:
        for origins in (("api.provider.example", corpus.API_ORIGIN), ("api.provider.example", ORIGIN)):
            with self.subTest(origins), self.assertRaises(artifact.IsolationError) as caught:
                self.launch(attestation_path=self.attestation(origins))
            self.assertEqual(caught.exception.code, "allowlist_gap")

    def test_the_stamp_rides_in_the_attestation_hash(self) -> None:
        payload = self.launch()
        record = json.loads(sorted((self.out / "records").glob("*.json"))[0].read_text(encoding="utf-8"))
        stamped = artifact.with_corpus(
            artifact.load_attestation(self.attestation()), artifact.CorpusStamp(**payload["corpus"])
        )
        self.assertEqual(record["isolation"]["attestation_hash"], stamped.hash())
        self.assertNotEqual(stamped.hash(), artifact.load_attestation(self.attestation()).hash())

    def test_the_automated_lane_states_its_own_terms(self) -> None:
        cases = {
            "--attestation": dict(attestation_path=None),
            "--plumbing": dict(plumbing=True),
            "--ci-live": dict(ci_live=True, plumbing=True),
        }
        for expected, kwargs in cases.items():
            with self.subTest(expected), self.assertRaises(cli.CliError) as caught:
                self.launch(**kwargs)
            self.assertIn(expected, str(caught.exception))
            self.assertFalse((self.out / "trials").exists())

    def test_an_automated_environment_still_refuses_a_run_that_claims_neither_lane(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            self.launch(automated=False)
        self.assertIn("automated environment", str(caught.exception))

    def test_a_dry_run_names_the_corpus_and_calls_nothing(self) -> None:
        api = FakeApi()
        payload = cli.live_run(self.out, self.manifest, dry_run=True, environ={}, stream=Stream(), corpus_api=api)
        self.assertEqual(payload["corpus"]["branch_id"], BRANCH)
        self.assertEqual(api.calls, [])

    def test_the_offline_lane_refuses_a_manifest_that_names_a_corpus(self) -> None:
        fake = support.synthetic_manifest(self.dir / "offline", corpus=CORPUS).path
        with self.assertRaises(cli.CliError) as caught:
            cli.fake_run(self.out, fake)
        self.assertIn("corpus", str(caught.exception))

    def test_a_manifest_without_a_corpus_needs_no_provider(self) -> None:
        cli.live_run(
            self.out,
            self.plain,
            self.attestation(("api.provider.example",)),
            automated=True,
            environ=self.environ,
            runtime=self.runtime,
        )
        published = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual((published["publishable"], published["automated"], published["corpus"]), (True, True, None))


class Stream:
    def write(self, text: str) -> None:
        self.text = text


class ShelfKnobTest(unittest.TestCase):
    """`--tenjin-source` is the only thing that says where a run publishes and searches.

    A manifest that resets a corpus names the shelf that database serves, so a
    source naming any other shelf would empty the bench branch and then measure
    somewhere else. Pointing a run at the operator's own `~/.tenjin` is exactly
    that, so it is a refusal.
    """

    class Source:
        def __init__(self, host: str | None) -> None:
            self.shelf_origin = host

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.manifest = manifest_module.load(support.synthetic_manifest(self.dir, live=True, corpus=CORPUS).path)
        self.plain = manifest_module.load(support.synthetic_manifest(self.dir / "plain", live=True).path)

    def test_a_source_naming_the_bench_shelf_passes(self) -> None:
        cli.refuse_foreign_shelf(self.manifest, self.Source(ORIGIN))

    def test_a_source_naming_the_team_shelf_is_refused(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli.refuse_foreign_shelf(self.manifest, self.Source("tenjin-shelf-backtrack.vercel.app"))
        self.assertIn(ORIGIN, str(caught.exception))
        self.assertIn("--tenjin-source", str(caught.exception))

    def test_a_source_with_no_shelf_at_all_is_refused(self) -> None:
        with self.assertRaises(cli.CliError):
            cli.refuse_foreign_shelf(self.manifest, self.Source(None))

    def test_a_manifest_that_resets_nothing_is_not_this_gate(self) -> None:
        cli.refuse_foreign_shelf(self.plain, self.Source("anything.example"))

    def test_a_dry_run_without_a_source_is_not_this_gate(self) -> None:
        cli.refuse_foreign_shelf(self.manifest, None)


if __name__ == "__main__":
    unittest.main()
