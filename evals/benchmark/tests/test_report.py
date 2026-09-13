"""The publishable projection and its redaction guard.

The guard cases plant real leak shapes rather than asserting a schema: a host
path, a provider credential, the benchmark's own canary, a prompt, and a
memory body, each pushed through a field the projection actually copies.
"""

from __future__ import annotations

import collections
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
            "invalid_reason": "sentinel:credential_exposure",
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


def test_the_corpus_projects_to_counts_enums_ids_and_hashes(corpus, project: Project, reduction: dict) -> None:
    _manifest, _digest, accepted, excluded = corpus
    published = project()
    assert published["schema"] == report.REPORT_SCHEMA
    assert published["baseline"] == "off"
    # One row per accepted attempt, and the refused files tallied by their
    # own reasons: both sides come off the corpus the case was handed.
    assert len(published["trials"]) == len(accepted)
    assert published["excluded"] == collections.Counter(item.reason for item in excluded)
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
    assert "ran the test before the fix" not in report.render(project())


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
        "agent_time_s",
        "arm_id",
        "auxiliary_receipts",
        "child_tokens",
        "credential_exposures",
        "harness_time_s",
        "invalid_reason",
        "local_hits",
        "outcome",
        "producer_outcome",
        "producer_tokens",
        "public_hits",
        "public_legs",
        "requests",
        "stop_reason",
        "task_id",
        "tokens",
        "trial_id",
        "unnamed_shelf_legs",
        "verification_time_s",
    ]
    # The corpus predates leg classes, so every origin count reads as zero
    # rather than as a missing field.
    assert published["origins"] == {"public_legs": 0, "public_hits": 0, "public_timeouts": 0, "unnamed_shelf_legs": 0}
    # The private record has fields the projection deliberately drops.
    private = accepted[trial["trial_id"]]
    assert "private_hashes" in private
    assert "delivery" in private
    assert "private_hashes" not in trial
    assert "delivery" not in trial


def test_the_trial_rows_sum_to_their_arm_total(corpus, project: Project, reduction: dict) -> None:
    """A trial's tokens are the reducer's numerator, not the native usage alone.

    The treatment arm carries a consumer-phase receipt on every attempt and one
    capture receipt on top. A row that dropped the first would sum below its
    arm; a row that added the second would sum above it. The scored rows are
    the ones that sum: an invalid attempt keeps the spend it really made, which
    the reducer excludes, so the gap between the two sums is that spend and
    nothing else.
    """
    _manifest, _digest, accepted, _excluded = corpus
    published = project()
    scored: dict[str, int] = {}
    every: dict[str, int] = {}
    for trial in published["trials"]:
        every[trial["arm_id"]] = every.get(trial["arm_id"], 0) + trial["tokens"]
        if trial["outcome"] != "invalid":
            scored[trial["arm_id"]] = scored.get(trial["arm_id"], 0) + trial["tokens"]
    assert scored == {arm_id: arm["tokens"] for arm_id, arm in reduction["arms"].items()}
    invalid = next(row for row in published["trials"] if row["outcome"] == "invalid")
    assert invalid["tokens"] > 0
    assert every[invalid["arm_id"]] - scored[invalid["arm_id"]] == invalid["tokens"]
    # The consumer receipt is inside the row and the capture receipt is not.
    treatment = next(row for row in published["trials"] if row["arm_id"] == "on" and row["auxiliary_receipts"] == 2)
    record = accepted[treatment["trial_id"]]
    native = sum(item["input_total"] + item["output_total"] for item in record["usage"])
    assert treatment["tokens"] == native + 500
    assert reduce_module.capture_tokens([record]) == 5000
    report.guard(published)


def test_the_slice_and_the_producer_reach_the_report_and_its_reading() -> None:
    record = support.reduction_record("t1", "on", 0, 1, 400, auxiliary=(support.receipt("producer", "producer", "p_1", 600, 200), support.receipt("producer", "capture", "p_2", 100, 50)))
    record["isolation"] = {**record["isolation"], "producer": {"outcome": "pass", "capture": {"pairings": {"open": 0, "unverified": 1, "verified": 0}, "findings": 0}, "phase_tokens": {"producer": 800, "capture": 150}, "wal_live_between_phases": False}, "slice": {"kind": "recursive"}}
    off = support.reduction_record("t1", "off", 0, 0, 800)
    accepted = support.accept(off, record)
    manifest_data = {"benchmark_version": "bench2-test", "price_sheet_version": "fake", "seed": 1, "repeats": 1, "slice": {"kind": "recursive"}, "pins": {}, "tasks": []}
    reduction = reduce_module.reduce(accepted, [], baseline="off")
    projected = report.project(manifest_data, "sha256:m", "sha256:s", reduction, accepted)
    assert projected["slice"] == {"kind": "recursive"}
    row = next(trial for trial in projected["trials"] if trial["arm_id"] == "on")
    assert (row["producer_outcome"], row["producer_tokens"], row["local_hits"], row["child_tokens"]) == ("pass", 950, 0, 0)
    text = report.render(projected)
    assert "slice: kind=recursive" in text
    assert "on producer phases: 1 run, 1 passed, 1 left a closed local record" in text
    # The pre-registered headline: capture-only amortized at reuse 1, first, with its own
    # task-paired interval; the reuse curve; the consumer-only ratio as the secondary line;
    # the producer's-own-work amortization last, as a diagnostic.
    comparison = projected["comparisons"]["on"]
    assert (comparison["headline"], comparison["headline_rule"], comparison["headline_eligible"]) == (round(550 / 800, 12), "system_tokens_per_verified_completion_reuse_1", True)
    assert (comparison["headline_interval"]["tasks"], comparison["headline_interval"]["point"]) == (1, round(550 / 800, 12))
    assert comparison["token_ratio"] == 0.5
    lines = text.splitlines()
    headline = next(index for index, line in enumerate(lines) if line.startswith("  headline on: 0.688 (" + report.HEADLINE_LABEL + ")"))
    assert "headline eligible" in lines[headline]
    assert lines[headline + 1].startswith("    per-completion reuse 2/5/10: 0.594/0.537/0.519")
    assert lines[headline + 2].startswith("    " + report.CAPTURE_FREE_LABEL + ": 0.500  interval")
    # The retrieval-only decomposition sits between the capture-free line
    # and the producer diagnostic, labelled where it is printed.
    assert "retrieval only, decomposition" in lines[headline + 3]
    assert lines[headline + 4].startswith("    per-attempt diagnostic, producer work charged too, reuse 1/10: 1.688/0.619")
    assert report.CAPTURE_FREE_LABEL == "capture-free (future: capture on an operator-run model)"
    # A non-publishable run keeps the number and loses the claim, on the headline line.
    for stamped_record in accepted.values():
        stamped_record["isolation"] = {**stamped_record["isolation"], "publishable": False}
    plumbing = report.project(manifest_data, "sha256:m", "sha256:s", reduction, accepted)
    assert plumbing["comparisons"]["on"]["headline_eligible"] is False
    assert "headline on: 0.688" in report.render(plumbing)
    assert "NOT headline eligible" in report.render(plumbing).splitlines()[headline]


def test_every_ratio_is_printed_beside_what_it_decomposes_into() -> None:
    """Round trips, unique ingestion, and the pass rate, under the headline and labelled apart from it."""
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 108000, "pass", requests=8, preamble=9000),
        support.reduction_record("t1", "on", 0, 1, 99000, "fail", requests=7, preamble=9000),
    )
    manifest_data = {"benchmark_version": "bench2-test", "price_sheet_version": "fake", "seed": 1, "repeats": 1, "pins": {}, "tasks": []}
    reduction = reduce_module.reduce(accepted, [], baseline="off")
    projected = report.project(manifest_data, "sha256:m", "sha256:s", reduction, accepted)
    report.guard(projected)
    lines = report.render(projected).splitlines()
    headline = next(index for index, line in enumerate(lines) if line.startswith("  headline on: "))
    rows = lines[headline : headline + 8]
    requests = next(line for line in rows if report.REQUESTS_LABEL in line)
    new_tokens = next(line for line in rows if report.NEW_TOKENS_LABEL in line)
    delta = next(line for line in rows if report.PASS_DELTA_LABEL in line)
    assert "7.00 versus    8.00, ratio 0.875" in requests
    # The arm spent 9,000 fewer tokens and sent nothing new less: the whole
    # gap is one request that replayed the preamble.
    assert "45000.0 versus    45000.0, ratio 1.000" in new_tokens
    assert "-1.000" in delta
    # Each one says what it is, and none of them claims to be the headline.
    for line in (requests, new_tokens, delta):
        assert ("decomposition" if line is not delta else "the other axis") in line
        assert report.HEADLINE_LABEL not in line


def test_a_hidden_category_prints_a_reason_where_the_new_token_ratio_would_be() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
        support.reduction_record("t1", "on", 0, 1, 8000, "pass"),
    )
    manifest_data = {"benchmark_version": "bench2-test", "price_sheet_version": "fake", "seed": 1, "repeats": 1, "pins": {}, "tasks": []}
    reduction = reduce_module.reduce(accepted, [], baseline="off")
    projected = report.project(manifest_data, "sha256:m", "sha256:s", reduction, accepted)
    text = report.render(projected)
    assert report.NEW_TOKENS_LABEL + ":       none versus       none, ratio none (categories_unexposed)" in text
    assert report.REQUESTS_LABEL + ":    1.00 versus    1.00, ratio 1.000" in text


def test_the_origin_counts_sum_the_public_legs_and_the_unnamed_shelf_legs(corpus, project: Project) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    records_in = {}
    for trial_id, record in accepted.items():
        copy = json.loads(json.dumps(record))
        copy["delivery"]["classes"] = {"team": 1, "public": 2, "local": 1, "other": 1}
        copy["delivery"]["public"] = {"legs": 2, "hits": 1, "timeouts": 1, "no_answer": 1}
        records_in[trial_id] = copy
    published = project(accepted_records=records_in)
    count = len(records_in)
    assert published["origins"] == {"public_legs": 2 * count, "public_hits": count, "public_timeouts": count, "unnamed_shelf_legs": count}
    assert published["trials"][0]["public_legs"] == 2
    assert published["trials"][0]["unnamed_shelf_legs"] == 1
    report.guard(published)


def test_a_record_may_hold_what_the_report_may_not() -> None:
    record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
    record["private_hashes"] = {"root_transcript": "sha256:" + "c" * 64, "executor_stderr": None}
    records.validate(record)
    # A whole record is never publishable: `private_hashes` is the record's
    # private-input slice, so a projection that wants any of it has to give
    # it a public name rather than forward the field.
    assert refusal(record).code == "private_field"


# The readout an anonymous reader can reach, and the cap GitHub imposes on it.


def test_the_summary_carries_the_headline_the_interval_and_the_method(corpus, project: Project) -> None:
    manifest, _digest, _accepted, _excluded = corpus
    text = report.check_summary(project())
    assert "## " + manifest.data["benchmark_version"] in text
    assert "headline on:" in text
    assert "interval [" in text
    assert "evals/benchmark/README.md" in text
    assert text.rstrip().endswith("</details>"), text[-40:]


def test_a_run_that_may_not_be_quoted_says_so_before_its_first_number(project: Project, stamped: Stamped) -> None:
    published = project(accepted_records=stamped(live=True, publishable=False))
    text = report.check_summary(published)
    assert text.index("not publishable") < text.index("headline on:")


def test_the_corpus_reading_is_stated_or_its_absence_is(project: Project) -> None:
    assert "was not read" in report.check_summary(project())
    published = {
        **project(),
        "corpus_snapshot": {"origin": "bench.tenjin.sh", "posts": 12, "content_hash": "sha256:ab", "taken_at": "2026-09-09T12:00:00Z"},
    }
    assert "12 pieces on `bench.tenjin.sh`" in report.check_summary(published)


def test_a_summary_over_the_cap_is_cut_and_says_it_was(project: Project) -> None:
    text = report.check_summary(project(), limit=900)
    assert len(text) <= 900
    assert "truncated" in text
    assert text.count("```text") == text.count("\n```\n")
    assert text.count("<details>") == text.count("</details>")


def test_the_cap_is_the_one_github_imposes(project: Project) -> None:
    assert report.CHECK_SUMMARY_LIMIT == 65535
    assert len(report.check_summary(project())) < report.CHECK_SUMMARY_LIMIT


# The corpus section. Its input is the projection, so the cases below build a
# projection rather than reduce a run to reach the one cell they are about;
# the case that reads a real one is `test_the_corpus_section_reads_the_run`.
Figures = tuple[float, float, float] | None


def corpus_report(cells: dict[str, dict[str, Figures]], baseline: str | None = "off") -> dict[str, Any]:
    """A report whose only content is a corpus: per-arm figures, or none for a task an arm never scored."""
    arms: dict[str, Any] = {}
    for task_id, row in cells.items():
        for arm_id, figures in row.items():
            arm = arms.setdefault(arm_id, {"tasks": {}})
            if figures is not None:
                arm["tasks"][task_id] = dict(zip(report.CELL_KEYS, figures))
    return {
        "arms": arms,
        "baseline": baseline,
        "corpus_tasks": [
            {
                "task_id": task_id,
                "family": "fam",
                "transfer_distance": "same_task",
                "verifier": "fake_answer_file",
                "fixture_hash": "sha256:" + "a" * 64,
            }
            for task_id in cells
        ],
    }


def task_order(lines: list[str]) -> list[str]:
    """The task id of each rendered row, in the order the section printed them."""
    return [line.split(" ", 1)[0] for line in lines[3:] if not line.startswith("...")]


def test_the_corpus_section_orders_tasks_by_discovery_cost() -> None:
    # Round trips in the baseline arm, most expensive first: the ordering is
    # the section's point, because it is what says whether the corpus holds an
    # expensive task at all. The token totals deliberately disagree with it.
    section = report.corpus_section(
        corpus_report(
            {
                "core": {"off": (6.33, 90000.0, 0.5), "on": (7.10, 80000.0, 0.5)},
                "level": {"off": (9.00, 10000.0, 1.0), "on": (2.33, 9000.0, 1.0)},
                "alias": {"off": (7.00, 50000.0, 0.0), "on": (6.00, 40000.0, 0.5)},
            }
        )
    )
    assert task_order(section) == ["level", "alias", "core"]
    assert section[0] == "corpus: 3 tasks, most expensive first by discovery cost, requests per attempt in off"
    assert "off (baseline)" in section[1] and "on" in section[1]
    assert section[2].split() == ["task", "family", "distance", "verifier", "fixture", "reqs", "tokens", "pass", "reqs", "tokens", "pass"]
    assert section[3].split()[5:] == ["9.00", "10000.0", "1.000", "2.33", "9000.0", "1.000"]


def test_a_task_with_no_valid_attempt_renders_rather_than_crashing() -> None:
    # The 2026-09-09 run: every attempt in one arm invalid, and one task the
    # baseline never scored either. A run that produced a report must print.
    section = report.corpus_section(
        corpus_report({"scored": {"off": (4.00, 1000.0, 1.0), "on": None}, "unscored": {"off": None, "on": None}})
    )
    assert task_order(section) == ["scored", "unscored"]
    # An unscored cell is `none` under every column, never a zero.
    assert section[3].split()[5:] == ["4.00", "1000.0", "1.000", "none", "none", "none"]
    assert section[4].split()[5:] == ["none", "none", "none", "none", "none", "none"]


def test_a_baseline_with_no_scored_task_says_the_order_is_not_a_ranking() -> None:
    section = report.corpus_section(corpus_report({"b": {"off": None, "on": (3.0, 10.0, 1.0)}, "a": {"off": None, "on": None}}))
    assert section[0] == "corpus: 2 tasks, ordered by task id: off scored no attempt, so no discovery cost is known"
    assert task_order(section) == ["a", "b"]


def test_a_one_arm_run_renders_the_corpus_section() -> None:
    section = report.corpus_section(corpus_report({"only": {"off": (5.0, 200.0, 1.0)}}))
    assert section[1].split() == ["off", "(baseline)"]
    assert section[2].split() == ["task", "family", "distance", "verifier", "fixture", "reqs", "tokens", "pass"]
    assert section[3].split()[5:] == ["5.00", "200.0", "1.000"]
    assert len(section) == 4


def test_the_corpus_section_caps_its_rows_and_says_how_many_it_dropped() -> None:
    # A corpus large enough to blow a check run's 65,535-character body is
    # truncated here rather than by the API, which cuts without saying so.
    over = report.CORPUS_ROWS + 7
    section = report.corpus_section(corpus_report({f"task-{index:03d}": {"off": (float(index), 10.0, 1.0)} for index in range(over)}))
    assert task_order(section) == [f"task-{index:03d}" for index in range(over - 1, over - 1 - report.CORPUS_ROWS, -1)]
    assert section[-1] == f"... 7 cheaper tasks not shown; all {over} are in report.json under corpus_tasks"
    assert len("\n".join(section)) < 65535


def test_the_corpus_section_reads_the_run(corpus, project: Project) -> None:
    manifest, _digest, _accepted, _excluded = corpus
    published = project()
    # The metadata only the manifest holds, projected so `summary` needs one file.
    assert published["corpus_tasks"] == [
        {
            "task_id": task["id"],
            "family": task["family"],
            "transfer_distance": task["transfer_distance"],
            "verifier": task["verifier"],
            "fixture_hash": task["fixture_hash"],
        }
        for task in manifest.tasks
    ]
    report.guard(published)
    section = report.corpus_section(published)
    assert task_order(section) == sorted(task["id"] for task in manifest.tasks)
    # Every figure is the reducer's own cell, never a number this reading made.
    cell = published["arms"]["off"]["tasks"]["task-0"]
    assert f"{cell['requests_per_attempt']:7.2f} {cell['tokens_per_attempt']:10.1f}" in "\n".join(section)
    # The readout ends with it: it is the only block a cut may reach.
    assert report.render(published).endswith("\n".join(section))



def test_overview_names_the_experiment_schedule_model_and_all_arms(project: Project) -> None:
    published = project()
    text = report.check_summary(published)
    assert "SYNTHETIC TEST — no product result" in text
    assert "Model: fake-model-0" in text
    assert "Ran: 12/12 attempts" in text
    assert "Verified / planned" in text
    assert "Consumer s / completion" in text
    assert "System tokens / completion" in text
    assert text.index("System tokens / completion") < text.index("<details>")
    assert "task-0, task-1, task-2" in text
    assert "| off |" in text and "| on |" in text
    assert "Consumer time is measured around agent execution" in text


def test_a_missing_arm_or_invalid_attempt_is_never_presented_as_a_complete_product_result(project: Project) -> None:
    published = project()
    published.update(isolation="attested", publishable=True, excluded={}, invalid=[])
    published["arms"].pop("on")
    assert report.run_status(published).startswith("INCOMPLETE")
    assert "| on | 0 / 6 |" in report.overview(published, markdown=True)
    assert "lower" not in report.overview(published)


def test_model_identity_is_guarded_before_it_reaches_the_public_summary(corpus, project: Project) -> None:
    manifest = corpus[0]
    with pytest.raises(ReportError):
        project({**manifest.data, "pins": {**manifest.pins, "model": HOST_PATH}})


def test_plan_summary_names_the_actual_matrix_without_claiming_results(corpus) -> None:
    text = report.plan_summary(corpus[0].data)
    assert "12 attempts = 3 tasks × 2 arms × 2 repeats" in text
    assert "Arm: off" in text and "Arm: on" in text
    assert "No result yet" in text


def test_subscription_exhaustion_has_an_unavailable_readout():
    value = {"isolation": "attested_container", "publishable": True,
             "trials": [{"invalid_reason": "provider:rate_limit"}]}
    assert report.run_status(value) == "UNAVAILABLE — model subscription/rate limit; no product result"


@pytest.mark.parametrize("status", ["changed", "unavailable"])
def test_remote_server_drift_cannot_look_like_a_product_result(corpus, reduction, status):
    manifest, digest, accepted, _ = corpus
    state = {"status": status, "deployment_id": "dpl_original", "checks": 2}
    value = report.project(manifest.data, manifest.hash, digest, reduction, accepted, server_revision=state)
    assert value["publishable"] is False
    assert all(not row["headline_eligible"] for row in value["comparisons"].values())
    text = report.overview(value)
    assert text.startswith("UNAVAILABLE")
    assert "diagnostic evidence only" in text
    assert "they do not lock the server or prove schema compatibility" in text
    assert "lower" not in text
