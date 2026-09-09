"""The publishable projection and its redaction guard.

The guard cases plant real leak shapes rather than asserting a schema: a host
path, a provider credential, the benchmark's own canary, a prompt, and a
memory body, each pushed through a field the projection actually copies.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import pytest

from evals.benchmark import artifact, records, reduce as reduce_module, report
from evals.benchmark.report import ReportError
from evals.benchmark.tests import support

HOST_PATH = "/Users/someone/.claude/projects/tenjin/transcript.jsonl"
CREDENTIAL = "sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF"
PROMPT = "Rename the slug helper and keep the old route working."
MEMORY_BODY = "The team lesson: the hook reads NEXT_PUBLIC_BUILDER_CODE and nothing else."

Project = Callable[..., dict]
Stamped = Callable[..., dict]


def refusal(value: object, trail: str = "report") -> ReportError:
    with pytest.raises(ReportError) as caught:
        report.guard(value, trail)
    return caught.value


@pytest.mark.parametrize("planted", (HOST_PATH, "~/.claude/settings.json", "C:\\Users\\someone\\repo", "evals/benchmark"))
def test_a_host_path_cannot_enter_the_projection(planted: str) -> None:
    assert refusal({"invalid_reason": planted}).code == "host_path"


@pytest.mark.parametrize(
    "planted",
    (
        CREDENTIAL,
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
        "AKIAIOSFODNN7EXAMPLE",
        "xoxb-1234567890-abcdefghij",
        "AIzaSyA1B2C3D4E5F6G7H8I9J0",
        artifact.canary_token("trial-1"),
    ),
)
def test_a_credential_cannot_enter_the_projection(planted: str) -> None:
    assert refusal({"arm_id": planted}).code == "credential"


@pytest.mark.parametrize("planted", (PROMPT, MEMORY_BODY, "assistant: I will edit the file now"))
def test_a_prompt_or_a_memory_body_cannot_enter_the_projection(planted: str) -> None:
    assert refusal({"reason": planted}).code == "not_opaque"


@pytest.mark.parametrize("key", ("prompt", "transcript", "memory", "question", "stderr", "cwd", "argv", "home", "url", "title"))
def test_a_private_field_is_refused_before_its_value_is_read(key: str) -> None:
    error = refusal({"trials": [{key: "ok"}]})
    assert error.code == "private_field"
    assert error.trail == f"report.trials[0].{key}"


def test_an_unpublishable_type_is_refused() -> None:
    assert refusal({"tokens": Path("/tmp/x")}).code == "unpublishable_type"
    assert refusal({"tokens": {1, 2}}).code == "unpublishable_type"


def test_hashes_counts_and_enums_are_publishable() -> None:
    report.guard(
        {
            "manifest_hash": "a" * 64,
            "schedule_hash": "sha256:" + "b" * 64,
            "trial_id": "27d0f0fe30d9608939dadc4c",
            "outcome": "capped",
            "invalid_reason": "sentinel:public_request",
            "token_ratio": 0.825,
            "attempts": 12,
            "headline_eligible": True,
            "reason": None,
        }
    )


def test_an_opaque_string_longer_than_the_cap_is_refused() -> None:
    assert refusal({"arm_id": "a" * 65}).code == "not_opaque"
    report.guard({"arm_id": "a" * 64})


@pytest.fixture(scope="module")
def reduction(corpus) -> dict:
    manifest, _digest, accepted, excluded = corpus
    return reduce_module.reduce(accepted, excluded, "off", manifest.data["seed"])


@pytest.fixture
def project(corpus, reduction: dict) -> Project:
    manifest, digest, accepted, _excluded = corpus

    def run(manifest_data: dict | None = None, accepted_records: dict | None = None) -> dict:
        return report.project(manifest_data or manifest.data, manifest.hash, digest, reduction, accepted_records or accepted)

    return run


@pytest.fixture
def stamped(corpus) -> Stamped:
    """The corpus with every accepted record's isolation slice overridden."""
    _manifest, _digest, accepted, _excluded = corpus

    def run(**isolation: object) -> dict:
        return {trial_id: {**record, "isolation": {**record["isolation"], **isolation}} for trial_id, record in accepted.items()}

    return run


def test_the_corpus_projects_to_counts_enums_ids_and_hashes(project: Project, reduction: dict) -> None:
    published = project()
    assert published["schema"] == report.REPORT_SCHEMA
    assert published["baseline"] == "off"
    assert len(published["trials"]) == 12
    assert published["excluded"] == {"stale": 1, "partial": 1, "foreign": 1}
    # The projection carries the reducer's number rather than recomputing one of its own.
    assert published["comparisons"]["on"]["token_ratio"] == reduction["comparisons"]["on"]["token_ratio"]
    # Nothing in the projection is a body, a path, or a transcript.
    report.guard(published)


def test_the_report_states_how_many_trials_ran_at_once(corpus, project: Project) -> None:
    # Two runs of one manifest are comparable only when they were run the
    # same way, and the records carry the degree inside `environment_hash`,
    # which a reader comparing them cannot read back.
    manifest, _digest, _accepted, _excluded = corpus
    assert project()["concurrency"] == 1
    published = project({**manifest.data, "pins": {**manifest.data["pins"], "concurrency": 4}})
    assert published["concurrency"] == 4
    assert "concurrency 4" in report.render(published)
    report.guard(published)


def test_a_fake_corpus_is_publishable_and_says_so(project: Project, reduction: dict) -> None:
    published = project()
    assert published["publishable"] is True
    assert published["isolation"] == "fake"
    assert published["comparisons"]["on"]["headline_eligible"] == reduction["comparisons"]["on"]["headline_eligible"]


def test_an_attested_live_run_stays_publishable_and_headline_eligible(project: Project, stamped: Stamped) -> None:
    published = project(accepted_records=stamped(live=True, attested_container=True, attestation_hash="sha256:" + "d" * 64))
    assert published["publishable"] is True
    assert published["isolation"] == "attested"
    assert published["comparisons"]["on"]["headline_eligible"] is True
    report.guard(published)


@pytest.mark.parametrize(("kind", "extra"), [("operator_plumbing", {}), ("automated_plumbing", {"automated": True})])
def test_a_plumbing_run_projects_as_non_publishable_and_never_headline_eligible(
    project: Project, stamped: Stamped, reduction: dict, kind: str, extra: dict
) -> None:
    published = project(accepted_records=stamped(live=True, publishable=False, **extra))
    assert published["publishable"] is False
    assert published["isolation"] == kind
    assert published["comparisons"]["on"]["headline_eligible"] is False
    # The numbers are unchanged: the stamp is a label, not a reduction.
    assert published["comparisons"]["on"]["token_ratio"] == reduction["comparisons"]["on"]["token_ratio"]
    assert published["arms"] == reduction["arms"]
    report.guard(published)


def test_one_non_publishable_record_stamps_the_whole_report(corpus, project: Project, stamped: Stamped) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    trial_id, record = sorted(accepted.items())[0]
    records_in = stamped(live=True, attested_container=True, attestation_hash="sha256:" + "d" * 64)
    records_in[trial_id] = {**record, "isolation": {**record["isolation"], "live": True, "publishable": False}}
    published = project(accepted_records=records_in)
    assert published["publishable"] is False
    assert published["isolation"] == "operator_plumbing"
    assert published["comparisons"]["on"]["headline_eligible"] is False


def test_a_seeded_shelf_secret_marks_the_report_and_its_reading(project: Project, stamped: Stamped) -> None:
    published = project(accepted_records=stamped(live=True, publishable=False, shelf_secret_present=True, shelf_origin="team-shelf.example"))
    assert (published["publishable"], published["isolation"], published["shelf_secret_present"]) == (False, "team_shelf_secret", True)
    assert published["comparisons"]["on"]["headline_eligible"] is False
    assert "team-shelf.example" not in json.dumps(published)
    report.guard(published)
    assert "team shelf secret present: NOT PUBLISHABLE" in report.render(published)
    assert project()["shelf_secret_present"] is False


def copies(accepted: dict[str, Any]) -> dict[str, Any]:
    return {trial_id: dict(record) for trial_id, record in accepted.items()}


def test_discovery_is_counted_per_arm(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    records_in = copies(accepted)
    first = sorted(records_in)[0]
    arm = records_in[first]["arm_id"]
    records_in[first]["discovery"] = {"setup_read": True, "setup_reads": 1, "test_run_before_fix": False, "failing_runs_before_fix": 0, "test_runs": 1, "source_edited": True}
    published = project(accepted_records=records_in)
    assert published["discovery"][arm] == {"attempts": 1, "test_run_before_fix": 0, "setup_read": 1}
    assert f"discovery {arm}: ran the test before the fix 0/1, read the setup file 1/1" in report.render(published)
    assert "discovery" not in report.render(project())


def test_the_failure_key_lane_and_keys_leg_verdict_are_summed_per_arm(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    records_in = copies(accepted)
    first = sorted(records_in)[0]
    arm = records_in[first]["arm_id"]
    records_in[first]["delivery"] = {
        **records_in[first]["delivery"],
        "failure_key": {"fire_id": "f", "lane": "sig_v1_test", "key_hash": "abcd", "keys_leg": {"status": "ok", "outcome": "hit"}, "keys_leg_hit": True, "reason": "hit", "delivered_piece_id": "p1", "report_file_present": True},
    }
    published = project(accepted_records=records_in)
    assert published["failure_keys"][arm]["keyed"] == 1
    assert published["failure_keys"][arm]["lanes"] == {"sig_v1_test": 1}
    rendered = report.render(published)
    assert f"failure key {arm}: keyed 1/" in rendered
    assert "(sig_v1_test x1), keys leg hit 1, report file 1, delivered 1" in rendered
    assert "failure key" not in report.render(project())


def test_a_seeded_piece_left_on_the_shelf_is_counted_and_the_summary_warns(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    seed = {"lesson": "fam", "title": "The lesson", "nonce": "20260908T000000Z-0badf00d", "key_hashes": ["abcd"], "keys": 1, "shelf_origin": "team-shelf.example", "piece_id": "piece-1", "published": True, "probe": None, "deleted": False, "delete_error": "tenjin delete exited 4: 502"}
    records_in = copies(accepted)
    first, second = sorted(records_in)[:2]
    records_in[first]["isolation"] = {**records_in[first]["isolation"], "seed": [seed, {**seed, "lesson": "fix", "piece_id": "piece-3", "deleted": True, "delete_error": None}]}
    records_in[second]["isolation"] = {**records_in[second]["isolation"], "seed": [{**seed, "piece_id": "piece-2", "deleted": True, "delete_error": None}]}
    published = project(accepted_records=records_in)
    assert published["seeds"] == {"published": 3, "not_deleted": 1}
    rendered = report.render(published)
    assert "seeded pieces: 3 published to the team shelf, 2 deleted" in rendered
    assert "WARNING: 1 seeded piece(s) still on the team shelf" in rendered
    assert project()["seeds"] == {"published": 0, "not_deleted": 0}
    assert "seeded pieces" not in report.render(project())


def test_a_record_that_seeded_a_secret_and_claims_publishable_is_refused() -> None:
    record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
    record["isolation"] = {**record["isolation"], "live": True, "shelf_secret_present": True}
    with pytest.raises(records.RecordError) as caught:
        records.validate(record)
    assert "shelf secret" in str(caught.value)


def test_a_record_without_the_isolation_booleans_is_excluded_not_projected() -> None:
    record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
    record["isolation"] = {"live": True, "fresh_roots": True, "attested_container": False, "attestation_hash": None}
    with pytest.raises(records.RecordError) as caught:
        records.validate(record)
    assert "isolation.publishable" in str(caught.value)


def test_a_planted_host_path_in_a_record_refuses_the_whole_report(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    trial_id, record = sorted(accepted.items())[0]
    planted = {**accepted, trial_id: {**record, "invalid_reason": f"usage:{HOST_PATH}"}}
    with pytest.raises(ReportError) as caught:
        project(accepted_records=planted)
    assert caught.value.code == "host_path"


def test_a_planted_credential_in_the_manifest_refuses_the_whole_report(corpus, project: Project) -> None:
    manifest, _digest, _accepted, _excluded = corpus
    with pytest.raises(ReportError) as caught:
        project({**manifest.data, "benchmark_version": CREDENTIAL})
    assert caught.value.code == "credential"
    assert caught.value.trail == "report.benchmark_version"


def test_the_projection_carries_no_usage_body_or_delivery_detail(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    published = project()
    trial = published["trials"][0]
    assert sorted(trial) == [
        "actors",
        "arm_id",
        "auxiliary_receipts",
        "invalid_reason",
        "other_requests",
        "outcome",
        "public_hits",
        "public_legs",
        "requests",
        "sentinel_hits",
        "stop_reason",
        "task_id",
        "tokens",
        "trial_id",
    ]
    # The corpus predates leg classes, so every origin count reads as zero
    # rather than as a missing field.
    assert published["origins"] == {"public_legs": 0, "public_hits": 0, "public_timeouts": 0, "other_requests": 0}
    # The private record has fields the projection deliberately drops.
    private = accepted[trial["trial_id"]]
    assert "private_hashes" in private
    assert "delivery" in private
    assert "private_hashes" not in trial
    assert "delivery" not in trial


def test_the_origin_counts_sum_the_public_legs_and_the_unknown_requests(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    records_in = {}
    for trial_id, record in accepted.items():
        copy = json.loads(json.dumps(record))
        copy["delivery"]["classes"] = {"team": 1, "public": 2, "local": 1, "other": 1}
        copy["delivery"]["public"] = {"legs": 2, "hits": 1, "timeouts": 1, "no_answer": 1}
        records_in[trial_id] = copy
    published = project(accepted_records=records_in)
    count = len(records_in)
    assert published["origins"] == {"public_legs": 2 * count, "public_hits": count, "public_timeouts": count, "other_requests": count}
    assert published["trials"][0]["public_legs"] == 2
    assert published["trials"][0]["other_requests"] == 1
    report.guard(published)


def test_a_record_may_hold_what_the_report_may_not() -> None:
    record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
    record["private_hashes"] = {"root_transcript": "sha256:" + "c" * 64, "executor_stderr": None}
    records.validate(record)
    # A whole record is never publishable: `private_hashes` is the record's
    # private-input slice, so a projection that wants any of it has to give
    # it a public name rather than forward the field.
    assert refusal(record).code == "private_field"
