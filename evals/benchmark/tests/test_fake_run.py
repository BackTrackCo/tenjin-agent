"""The walking skeleton: one fake manifest through every seam, offline."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals.benchmark import artifact, cli, executor, manifest, records, report, runner, schedule
from evals.benchmark.manifest import ManifestError

Run = tuple[Path, dict, dict]


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> Run:
    """One fake run and its resume, so every case reads the same finished chain."""
    out = tmp_path_factory.mktemp("fake-run") / "run"
    return out, cli.fake_run(out), cli.fake_run(out)


def test_schedule_and_hash_are_written(run: Run) -> None:
    out, first, _ = run
    payload = json.loads((out / "schedule.json").read_text())
    digest = (out / "schedule.sha256").read_text().strip()
    assert payload["schedule_hash"] == digest
    assert first["schedule_hash"] == digest
    assert len(payload["trials"]) == 2


def test_every_trial_passes_and_counts_each_request_once(run: Run) -> None:
    out, first, _ = run
    assert set(first["outcomes"].values()) == {"pass"}
    for path in (out / "records").glob("*.json"):
        record = json.loads(path.read_text())
        records.validate(record)
        assert record["outcome"] == "pass"
        # Root emits req_1 (partial + final rows) and req_2; the child emits one.
        assert [item["native_request_id"] for item in record["usage"]] == ["req_1", "req_2", "req_c1"]
        assert len(record["actors"]) == 2
        assert record["actors"][0]["key"][2] == ""
        assert record["actors"][0]["parent_provenance"] == "unavailable"
        # The fake child names its dispatching tool call, a structured native edge.
        assert record["actors"][1]["parent_provenance"] == "native"
        assert record["actors"][1]["parent_actor_key"] == record["actors"][0]["key"]
        assert record["usage_reconciliation"]["status"] == "matched"
        assert record["delivery"]["status"] == "unavailable"
        assert record["tool_counts"] == {"": {"Task": 1}}
        assert record["patch_hash"].startswith("sha256:")
        assert record["usage"][0]["reasoning_output_subset"] is None


def test_resume_skips_every_published_record(run: Run) -> None:
    _, first, second = run
    assert first["resumed"] == 0
    assert second["resumed"] == 2
    assert first["outcomes"] == second["outcomes"]


def test_report_is_publishable(run: Run) -> None:
    out, _, _ = run
    payload = json.loads((out / "report.json").read_text())
    report.guard(payload)
    assert set(payload["arms"]) == {"off", "on"}
    for arm in payload["arms"].values():
        assert arm["pass_rate"] == 1.0
        assert arm["tokens_per_verified_resolution"] is not None
    assert payload["arms"]["off"]["tokens"] > payload["arms"]["on"]["tokens"]


def test_verifier_bytes_are_absent_from_the_agent_mount(run: Run) -> None:
    out, _, _ = run
    for trial in (out / "trials").iterdir():
        assert not (trial / "repo" / "verifier.py").exists()
        assert (trial / "verify" / "answer.txt").is_file()


def test_verify_reruns_each_hidden_verifier_and_reports_disagreement(run: Run) -> None:
    out, _, _ = run
    payload = cli.do_verify(out)
    assert payload["disagreements"] == []
    assert all(item["agrees"] for item in payload["trials"].values())
    trial_id = sorted(payload["trials"])[0]
    answer = out / "trials" / trial_id / "verify" / "answer.txt"
    original = answer.read_text(encoding="utf-8")
    answer.write_text("41\n", encoding="utf-8")
    try:
        second = cli.do_verify(out)
    finally:
        answer.write_text(original, encoding="utf-8")
    assert second["disagreements"] == [trial_id]
    assert second["trials"][trial_id] == {"status": "fail", "recorded": "pass", "agrees": False}


def test_run_interrupt_resume_verify_reduce_and_report(tmp_path: Path) -> None:
    """The whole offline path in one case, with a real interruption in it.

    Every other case injects a seam. This one drives the shipped CLI: real
    executor processes, a hard interruption between two trials, a resume, a
    fresh verifier pass, the reducer, and the publishable report.
    """
    out = tmp_path / "run"
    spawns: list[str] = []

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        spawns.append(launch.root_session_id)
        if len(spawns) == 2:
            raise KeyboardInterrupt
        return runner.process_spawn(launch, roots, timeout_s)

    with pytest.raises(KeyboardInterrupt):
        cli.fake_run(out, runtime=runner.Runtime(spawn=spawn))
    records_dir = out / "records"
    # The interrupted trial published nothing; the finished one is final.
    assert len(list(records_dir.glob("*.json"))) == 1
    assert list(records_dir.glob("*.partial.*")) == []
    assert not (out / "report.json").exists()
    first = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}

    resumed = cli.fake_run(out)
    assert resumed["trials"] == 2
    assert resumed["resumed"] == 1
    assert set(resumed["outcomes"].values()) == {"pass"}
    after = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}
    assert len(after) == 2
    for name, value in first.items():
        assert after[name] == value, f"{name} was rewritten on resume"

    assert cli.do_verify(out)["disagreements"] == []
    reduction = cli.do_reduce(out)
    assert reduction["baseline"] == "off"
    assert reduction["excluded"] == []
    assert reduction["invalid"] == []
    assert reduction["arms"]["on"]["accounting"] == "complete"

    published = json.loads((out / "report.json").read_text(encoding="utf-8"))
    report.guard(published)
    assert published["baseline"] == "off"
    assert published["comparisons"]["on"]["token_ratio"] < 1.0
    assert published["comparisons"]["on"]["interval"]["tasks"] == 1


def test_same_seed_reproduces_the_schedule() -> None:
    loaded = manifest.load(cli.FAKE_MANIFEST)
    assert schedule.expand(loaded) == schedule.expand(loaded)


def test_manifest_hash_change_invalidates_the_run(fake_run: Path) -> None:
    payload = json.loads((fake_run / "schedule.json").read_text())
    payload["manifest_hash"] = "sha256:other"
    (fake_run / "schedule.json").write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ManifestError):
        cli.do_report(fake_run)


def test_report_guard_refuses_private_strings() -> None:
    with pytest.raises(report.ReportError):
        report.guard({"trials": [{"note": "/Users/someone/.claude/transcript.jsonl"}]})
    with pytest.raises(report.ReportError):
        report.guard({"prompt": "x"})
