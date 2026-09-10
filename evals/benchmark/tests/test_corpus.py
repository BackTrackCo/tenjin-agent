"""The corpus reset, its guard, and the automated lane the attestation opens.

Every case runs against a fake provider, which is the point of the seam: the
branches the plan names do not exist yet, and a guard that could only be tested
against a live project would be tested after it was needed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import pytest

from evals.benchmark import artifact, cli, corpus as corpus_module, executor, manifest as manifest_module, records, report, runner
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


class Stream:
    def write(self, text: str) -> None:
        self.text = text


def parsed(**overrides: str) -> corpus_module.Corpus:
    return corpus_module.parse({**CORPUS, **overrides})


def test_a_corpus_block_parses_into_the_ids_a_reset_needs() -> None:
    config = parsed()
    assert (config.project_id, config.branch_id, config.parent_id) == (PROJECT, BRANCH, PARENT)
    assert config.origins == (ORIGIN, corpus_module.API_ORIGIN)


@pytest.mark.parametrize(
    ("code", "override"),
    [("corpus_provider", {"provider": "postgres"}), ("corpus_shape", {"branch_id": "br bench"})],
)
def test_a_malformed_corpus_block_is_refused_before_anything_is_spent(code: str, override: dict) -> None:
    with pytest.raises(CorpusError) as caught:
        parsed(**override)
    assert caught.value.code == code


@pytest.mark.parametrize("missing", sorted(corpus_module.CORPUS_KEYS))
def test_a_corpus_block_missing_a_key_is_refused(missing: str) -> None:
    with pytest.raises(CorpusError) as caught:
        corpus_module.parse({key: value for key, value in CORPUS.items() if key != missing})
    assert caught.value.code == "corpus_shape"


def test_a_branch_that_is_its_own_parent_is_not_a_reset() -> None:
    with pytest.raises(CorpusError) as caught:
        parsed(parent_id=BRANCH)
    assert caught.value.code == "corpus_shape"


def test_a_manifest_carries_the_corpus_through_load_and_validation(tmp_path: Path) -> None:
    written = support.synthetic_manifest(tmp_path, corpus=CORPUS)
    assert manifest_module.load(written.path).corpus == parsed()
    broken = json.loads(written.path.read_text(encoding="utf-8"))
    broken["corpus"] = {**CORPUS, "provider": "sqlite"}
    written.path.write_text(json.dumps(broken), encoding="utf-8")
    with pytest.raises(manifest_module.ManifestError):
        manifest_module.load(written.path)


def test_a_manifest_without_a_corpus_resets_nothing(tmp_path: Path) -> None:
    assert manifest_module.load(support.synthetic_manifest(tmp_path).path).corpus is None


# A reset names a branch, so every refusal is about the branch.


def test_the_branch_the_manifest_names_is_reset() -> None:
    corpus_module.guard(parsed(), ROW)


@pytest.mark.parametrize(
    ("row", "code"),
    [
        pytest.param({**ROW, "default": True}, "default_branch", id="default branch"),
        # The field the newer API renamed. A guard that reads one name only
        # would wave a default branch through on the other.
        pytest.param({**ROW, "primary": True}, "default_branch", id="primary branch"),
        pytest.param({**ROW, "protected": True}, "protected_branch", id="protected branch"),
        pytest.param({**ROW, "id": "br-someone-elses"}, "branch_mismatch", id="another branch id"),
        pytest.param({}, "branch_unreadable", id="unreadable row"),
        # The parent is the source of the restore, so an unexpected one fills
        # the corpus with rows no record accounts for.
        pytest.param({**ROW, "parent_id": "br-somewhere-else"}, "parent_mismatch", id="another parent"),
        pytest.param({**ROW, "parent_id": None}, "parent_mismatch", id="no parent"),
    ],
)
def test_a_branch_the_manifest_did_not_name_is_never_reset(row: dict, code: str) -> None:
    with pytest.raises(CorpusError) as caught:
        corpus_module.guard(parsed(), row)
    assert caught.value.code == code


def test_the_team_shelfs_own_main_is_refused_as_a_target() -> None:
    # The project this runs in holds the team's knowledge. Measured
    # 2026-09-09: its `main` is the default branch and is unprotected, so
    # the default rule is the one that catches it.
    config = corpus_module.parse({**CORPUS, "branch_id": "br-dry-sound-av487ewe"})
    with pytest.raises(CorpusError) as caught:
        corpus_module.guard(config, {"id": "br-dry-sound-av487ewe", "default": True, "protected": False, "parent_id": PARENT})
    assert caught.value.code == "default_branch"


def test_a_reset_reads_the_branch_first_and_stamps_what_it_reset() -> None:
    api = FakeApi()
    stamp = corpus_module.reset(parsed(), api, now=lambda: "2026-09-09T00:00:00Z")
    assert api.calls == [("branch", PROJECT, BRANCH), ("reset", PROJECT, BRANCH, PARENT)]
    assert (stamp.project_id, stamp.branch_id, stamp.parent_id, stamp.origin, stamp.reset_at) == (
        PROJECT,
        BRANCH,
        PARENT,
        ORIGIN,
        "2026-09-09T00:00:00Z",
    )
    assert stamp.api_origin == corpus_module.API_ORIGIN


def test_a_refused_guard_resets_nothing() -> None:
    api = FakeApi(row={**ROW, "protected": True})
    with pytest.raises(CorpusError):
        corpus_module.reset(parsed(), api)
    assert api.calls == [("branch", PROJECT, BRANCH)]


@pytest.mark.parametrize(
    ("api", "code"),
    [
        pytest.param(FakeApi(reset_error=CorpusError("reset_failed", "the operation ended failed")), "reset_failed", id="failed reset"),
        pytest.param(FakeApi(row=CorpusError("api_unreachable", "no answer")), "api_unreachable", id="unreachable provider"),
    ],
)
def test_a_failed_reset_and_an_unreachable_provider_both_raise(api: FakeApi, code: str) -> None:
    with pytest.raises(CorpusError) as caught:
        corpus_module.reset(parsed(), api)
    assert caught.value.code == code


# The Neon implementation's own logic, short of the socket.


@pytest.fixture
def http_api() -> Callable[[list[dict]], corpus_module.HttpApi]:
    def build(answers: list[dict]) -> corpus_module.HttpApi:
        client = corpus_module.HttpApi(api_key="k", poll_interval_s=0.0, poll_cap_s=0.0, sleep=lambda _seconds: None)
        object.__setattr__(client, "_call", lambda *args, **kwargs: answers.pop(0))
        return client

    return build


def test_a_missing_api_key_refuses_before_the_first_call() -> None:
    with pytest.raises(CorpusError) as caught:
        corpus_module.HttpApi.from_env({})
    assert caught.value.code == "api_key_missing"
    assert corpus_module.HttpApi.from_env({corpus_module.API_KEY_VAR: "k"}).api_key == "k"


def test_a_started_reset_is_not_a_finished_one(http_api) -> None:
    http_api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "finished"}}]).reset_to_parent(PROJECT, BRANCH, PARENT)
    with pytest.raises(CorpusError) as caught:
        http_api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "failed"}}]).reset_to_parent(PROJECT, BRANCH, PARENT)
    assert caught.value.code == "reset_failed"


def test_an_operation_that_never_finishes_ends_the_run(http_api) -> None:
    with pytest.raises(CorpusError) as caught:
        http_api([{"operations": [{"id": "op-1"}]}, {"operation": {"status": "running"}}]).reset_to_parent(PROJECT, BRANCH, PARENT)
    assert caught.value.code == "reset_timeout"


def test_a_branch_response_without_a_branch_is_refused(http_api) -> None:
    with pytest.raises(CorpusError) as caught:
        http_api([{"nothing": True}]).branch(PROJECT, BRANCH)
    assert caught.value.code == "branch_unreadable"


# `--automated` end to end: reset, attest, publish, and every refusal on the way.


@pytest.fixture
def lane(tmp_path: Path, register_executor, live_gates) -> "Lane":
    register_executor(
        LIVE,
        ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
        ),
    )
    return Lane(tmp_path)


class Lane:
    """One automated live run of the corpus manifest, with every seam faked."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.out = directory / "run"
        self.manifest = support.synthetic_manifest(directory, executor_name=LIVE, live=True, corpus=CORPUS).path
        self.plain = support.synthetic_manifest(directory / "plain", executor_name=LIVE, live=True).path
        self.runtime = runner.Runtime(spawn=support.fake_spawn(), settle_cap_s=0.0)
        self.environ = {"CI": "1", "GITHUB_ACTIONS": "true"}

    def attestation(self, origins: tuple[str, ...] = ("api.provider.example", ORIGIN, corpus_module.API_ORIGIN)) -> Path:
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


def test_an_automated_attested_run_resets_the_corpus_and_publishes(lane: Lane) -> None:
    api = FakeApi()
    payload = lane.launch(api)
    assert api.calls == [("branch", PROJECT, BRANCH), ("reset", PROJECT, BRANCH, PARENT)]
    assert payload["corpus"]["branch_id"] == BRANCH
    published = json.loads((lane.out / "report.json").read_text(encoding="utf-8"))
    assert (published["publishable"], published["isolation"], published["automated"]) == (True, "attested", True)
    assert published["corpus"]["project_id"] == PROJECT
    assert published["corpus"]["parent_id"] == PARENT
    report.guard(published)
    assert f"corpus neon project {PROJECT}" in report.render(published)
    for path in sorted((lane.out / "records").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        records.validate(record)
        assert record["isolation"]["corpus"]["branch_id"] == BRANCH
        assert record["isolation"]["automated"] is True
        assert record["isolation"]["publishable"] is True


def test_the_reset_happens_before_the_first_trial(lane: Lane, monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []

    def spawn(launch, roots, timeout_s):
        order.append("trial")
        return support.fake_spawn()(launch, roots, timeout_s)

    lane.runtime = runner.Runtime(spawn=spawn, settle_cap_s=0.0)
    real_reset = corpus_module.reset

    def watched(*args, **kwargs):
        order.append("reset")
        return real_reset(*args, **kwargs)

    monkeypatch.setattr(corpus_module, "reset", watched)
    lane.launch(FakeApi())
    assert order[0] == "reset"
    assert order.count("reset") == 1
    assert order.count("trial") > 0


@pytest.mark.parametrize(
    "api",
    [
        pytest.param(FakeApi(row={**ROW, "default": True}), id="guard refuses"),
        pytest.param(FakeApi(reset_error=CorpusError("reset_failed", "operation failed")), id="reset fails"),
    ],
)
def test_a_reset_that_fails_refuses_the_run_before_any_root_exists(lane: Lane, api: FakeApi) -> None:
    with pytest.raises(CorpusError):
        lane.launch(api)
    assert not (lane.out / "trials").exists()
    assert not (lane.out / "records").exists()


@pytest.mark.parametrize(
    "origins",
    [
        pytest.param(("api.provider.example", corpus_module.API_ORIGIN), id="without the bench origin"),
        pytest.param(("api.provider.example", ORIGIN), id="without the api origin"),
    ],
)
def test_an_attestation_that_does_not_name_the_bench_origin_is_refused(lane: Lane, origins: tuple[str, ...]) -> None:
    with pytest.raises(artifact.IsolationError) as caught:
        lane.launch(attestation_path=lane.attestation(origins))
    assert caught.value.code == "allowlist_gap"


def test_the_stamp_rides_in_the_attestation_hash(lane: Lane) -> None:
    payload = lane.launch()
    record = json.loads(sorted((lane.out / "records").glob("*.json"))[0].read_text(encoding="utf-8"))
    stamped = artifact.with_corpus(artifact.load_attestation(lane.attestation()), artifact.CorpusStamp(**payload["corpus"]))
    assert record["isolation"]["attestation_hash"] == stamped.hash()
    assert stamped.hash() != artifact.load_attestation(lane.attestation()).hash()


@pytest.mark.parametrize(
    ("expected", "kwargs"),
    [
        ("--attestation", dict(attestation_path=None)),
        ("--plumbing", dict(plumbing=True)),
        ("--ci-live", dict(ci_live=True, plumbing=True)),
    ],
)
def test_the_automated_lane_states_its_own_terms(lane: Lane, expected: str, kwargs: dict) -> None:
    with pytest.raises(cli.CliError) as caught:
        lane.launch(**kwargs)
    assert expected in str(caught.value)
    assert not (lane.out / "trials").exists()


def test_an_automated_environment_still_refuses_a_run_that_claims_neither_lane(lane: Lane) -> None:
    with pytest.raises(cli.CliError) as caught:
        lane.launch(automated=False)
    assert "automated environment" in str(caught.value)


def test_a_dry_run_names_the_corpus_and_calls_nothing(lane: Lane) -> None:
    api = FakeApi()
    payload = cli.live_run(lane.out, lane.manifest, dry_run=True, environ={}, stream=Stream(), corpus_api=api)
    assert payload["corpus"]["branch_id"] == BRANCH
    assert api.calls == []


def test_the_offline_lane_refuses_a_manifest_that_names_a_corpus(lane: Lane) -> None:
    fake = support.synthetic_manifest(lane.dir / "offline", corpus=CORPUS).path
    with pytest.raises(cli.CliError) as caught:
        cli.fake_run(lane.out, fake)
    assert "corpus" in str(caught.value)


def test_a_manifest_without_a_corpus_needs_no_provider(lane: Lane) -> None:
    cli.live_run(
        lane.out,
        lane.plain,
        lane.attestation(("api.provider.example",)),
        automated=True,
        environ=lane.environ,
        runtime=lane.runtime,
    )
    published = json.loads((lane.out / "report.json").read_text(encoding="utf-8"))
    assert (published["publishable"], published["automated"], published["corpus"]) == (True, True, None)


# `--tenjin-source` is the only thing that says where a run publishes and searches.
#
# A manifest that resets a corpus names the shelf that database serves, so a
# source naming any other shelf would empty the bench branch and then measure
# somewhere else. Pointing a run at the operator's own `~/.tenjin` is exactly
# that, so it is a refusal.


class Source:
    def __init__(self, host: str | None) -> None:
        self.shelf_origin = host


@pytest.fixture
def resetting(tmp_path: Path) -> manifest_module.Manifest:
    return manifest_module.load(support.synthetic_manifest(tmp_path, live=True, corpus=CORPUS).path)


@pytest.fixture
def resets_nothing(tmp_path: Path) -> manifest_module.Manifest:
    return manifest_module.load(support.synthetic_manifest(tmp_path / "plain", live=True).path)


def test_a_source_naming_the_bench_shelf_passes(resetting: manifest_module.Manifest) -> None:
    cli.refuse_foreign_shelf(resetting, Source(ORIGIN))


def test_a_source_naming_the_team_shelf_is_refused(resetting: manifest_module.Manifest) -> None:
    with pytest.raises(cli.CliError) as caught:
        cli.refuse_foreign_shelf(resetting, Source("tenjin-shelf-backtrack.vercel.app"))
    assert ORIGIN in str(caught.value)
    assert "--tenjin-source" in str(caught.value)


def test_a_source_with_no_shelf_at_all_is_refused(resetting: manifest_module.Manifest) -> None:
    with pytest.raises(cli.CliError):
        cli.refuse_foreign_shelf(resetting, Source(None))


def test_a_manifest_that_resets_nothing_is_not_this_gate(resets_nothing: manifest_module.Manifest) -> None:
    cli.refuse_foreign_shelf(resets_nothing, Source("anything.example"))


def test_a_dry_run_without_a_source_is_not_this_gate(resetting: manifest_module.Manifest) -> None:
    cli.refuse_foreign_shelf(resetting, None)


# The attestation an unwatched lane presents: derived, not retyped.


@pytest.fixture
def attest(tmp_path: Path, register_executor) -> "Attest":
    register_executor(
        LIVE,
        ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
        ),
    )
    return Attest(tmp_path)


class Attest:
    """One `attest` command: the corpus manifest, the shelf source it derives from, and the file it writes."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.manifest = support.synthetic_manifest(directory, executor_name=LIVE, live=True, corpus=CORPUS).path
        self.source = support.tenjin_source(directory / "bench-data", base_url=f"https://{ORIGIN}")
        self.out = directory / "attestation.json"

    def __call__(self, **kwargs) -> dict:
        return cli.do_attest(
            kwargs.pop("manifest", self.manifest),
            kwargs.pop("tenjin_source", self.source),
            "gha-1-1",
            "ubuntu-24.04",
            "vm",
            self.out,
        )


def test_the_allowlist_is_the_provider_the_two_shelves_and_the_control_plane(attest: Attest) -> None:
    payload = attest()
    assert payload["network_allowlist"] == sorted({"api.provider.example", ORIGIN, "tenjin.blog", corpus_module.API_ORIGIN})
    assert (payload["fresh_roots"], payload["wallet_present"], payload["kind"]) == (True, False, "vm")
    assert json.loads(attest.out.read_text(encoding="utf-8")) == payload


def test_the_file_it_writes_is_one_live_run_accepts(attest: Attest) -> None:
    attest()
    artifact.check_attestation(artifact.load_attestation(attest.out), (ORIGIN, corpus_module.API_ORIGIN))


def test_a_source_naming_another_shelf_is_refused_before_a_file_exists(attest: Attest) -> None:
    other = support.tenjin_source(attest.dir / "team-data", base_url="https://team-shelf.example")
    with pytest.raises(cli.CliError):
        attest(tenjin_source=other)
    assert not attest.out.exists()


def test_a_source_carrying_a_shelf_secret_is_refused(attest: Attest) -> None:
    secret = support.tenjin_source(attest.dir / "secret-data", base_url=f"https://{ORIGIN}", shelf_secret="s3cret")
    with pytest.raises(cli.CliError) as caught:
        attest(tenjin_source=secret)
    assert "never publishable" in str(caught.value)
    assert not attest.out.exists()
