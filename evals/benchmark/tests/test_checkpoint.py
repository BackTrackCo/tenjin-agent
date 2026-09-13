"""Run ownership and immutable full-schedule identity across partial executions."""
import json
import dataclasses

import pytest

from evals.benchmark import cli, lease, manifest, report, runner, schedule


def test_second_writer_cannot_enter_a_run_directory(tmp_path):
    with lease.acquire(tmp_path):
        with pytest.raises(lease.LeaseError, match="another process"):
            with lease.acquire(tmp_path):
                pytest.fail("two writers entered")
    with lease.acquire(tmp_path):
        pass


def test_partial_execution_retains_full_schedule_identity_and_resumes(tmp_path):
    config = manifest.load(cli.FAKE_MANIFEST)
    full = schedule.expand(config)
    first = cli.execute(config, full[:2], tmp_path, runner.Runtime())
    frozen = json.loads((tmp_path / "schedule.json").read_text())
    assert len(frozen["trials"]) == len(full)
    assert first["schedule_hash"] == schedule.schedule_hash(full)
    partial = json.loads((tmp_path / "report.json").read_text())
    assert partial["run_configuration"]["planned_per_arm"] == len(config.tasks) * config.data["repeats"]
    second = cli.execute(config, full, tmp_path, runner.Runtime())
    assert second["resumed"] == 2
    assert first["schedule_hash"] == second["schedule_hash"]


def test_different_identity_is_refused_before_sidecar_changes(tmp_path):
    config = manifest.load(cli.FAKE_MANIFEST)
    cli.run_nonce(tmp_path, config)
    original = (tmp_path / "manifest.json").read_bytes()
    config = dataclasses.replace(config, hash="sha256:changed")
    with pytest.raises(cli.CliError, match="identity differs"):
        cli.run_nonce(tmp_path, config)
    assert (tmp_path / "manifest.json").read_bytes() == original


def test_exception_still_writes_an_empty_readable_checkpoint(tmp_path, monkeypatch):
    config = manifest.load(cli.FAKE_MANIFEST)
    def fail(*args):
        raise RuntimeError("execution broke")
    monkeypatch.setattr(runner, "run", fail)
    with pytest.raises(RuntimeError, match="execution broke"):
        cli.execute(config, schedule.expand(config), tmp_path, runner.Runtime())
    partial = json.loads((tmp_path / "report.json").read_text())
    assert all(arm["attempts"] == 0 for arm in partial["arms"].values())
    assert f"0/{len(schedule.expand(config))} attempts" in report.overview(partial)


def test_saved_schedule_is_validated_without_mutating_it(tmp_path):
    config = manifest.load(cli.FAKE_MANIFEST)
    path = tmp_path / "schedule.json"
    path.write_text(json.dumps({"manifest_hash": config.hash, "schedule_hash": "changed"}))
    before = path.read_bytes()
    with pytest.raises(cli.CliError, match="existing schedule differs"):
        cli.validate_schedule_identity(config, tmp_path)
    assert path.read_bytes() == before


def test_resource_lock_does_not_split_one_target_across_aliases(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from evals.benchmark.tests import support
    config = {"provider": "neon", "project_id": "project", "branch_id": "target", "parent_id": "source", "origin": "bench.example"}
    paths = []
    @contextmanager
    def acquire(path):
        paths.append(path)
        yield
    monkeypatch.setattr(lease, "acquire", acquire)
    monkeypatch.setattr(cli, "_live_run", lambda *args, **kwargs: {})
    first = support.synthetic_manifest(tmp_path / "a", corpus=config)
    second = support.synthetic_manifest(tmp_path / "b", corpus={**config, "parent_id": "other-source", "origin": "alias.example"})
    cli.live_run(tmp_path / "out-a", first.path)
    cli.live_run(tmp_path / "out-b", second.path)
    assert paths[1] == paths[3]
    assert paths[0] != paths[2]


@pytest.mark.parametrize("degree", [1, 3])
def test_admission_deadline_finishes_active_work_and_preserves_pending(tmp_path, monkeypatch, degree):
    from evals.benchmark.tests import support
    import threading
    config = support.synthetic_manifest(tmp_path, arms=("off", "off2"), repeats=3, concurrency=degree)
    trials = schedule.expand(config)
    expired = threading.Event()
    calls = []
    def attempt(config, trial, *args):
        calls.append(trial.trial_id)
        expired.set()
        return runner.TrialResult(trial.trial_id, "pass", False, tmp_path / (trial.trial_id + ".json"))
    monkeypatch.setattr(runner, "attempt", attempt)
    runtime = runner.Runtime(clock=lambda: 2 if expired.is_set() else 0, admit_until=1)
    results = runner.run(config, trials, tmp_path / "out", schedule.schedule_hash(trials), runtime)
    assert 1 <= len(results) <= degree
    assert len(results) == len(calls) < len(trials)
    assert [r.trial_id for r in results] == [t.trial_id for t in trials if t.trial_id in calls]


def test_chunk_loop_stops_at_admission_deadline(tmp_path, monkeypatch):
    from evals.benchmark.tests import support
    config = support.synthetic_manifest(tmp_path)
    now = [0]
    calls = []
    def chunk(*args, **kwargs):
        calls.append(kwargs)
        now[0] = 6
        return {"trials": 1}
    monkeypatch.setattr(cli, "_live_run", chunk)
    result = cli.live_run(tmp_path / "out", config.path, max_new_trials=1, until_complete=True,
                          admission_seconds=5, runtime=runner.Runtime(clock=lambda: now[0]))
    assert len(calls) == 1
    assert calls[0]["runtime"].admit_until == 5
    assert result["deadline_reached"] is True


def test_chunk_loop_continues_until_complete(tmp_path, monkeypatch):
    from evals.benchmark.tests import support
    config = support.synthetic_manifest(tmp_path)
    remaining = iter([{"trials": 1}, {"complete": True}])
    monkeypatch.setattr(cli, "_live_run", lambda *a, **kw: next(remaining))
    assert cli.live_run(tmp_path / "out", config.path, max_new_trials=1, until_complete=True)["complete"]


def test_cli_dry_run_does_not_forward_loop_options(tmp_path, monkeypatch):
    def dry(*args, **kwargs):
        assert "until_complete" not in kwargs
        assert "admission_seconds" not in kwargs
        return {"dry_run": True}
    monkeypatch.setattr(cli, "_live_run", dry)
    assert cli.live_run(tmp_path, cli.FAKE_MANIFEST, dry_run=True, until_complete=False, admission_seconds=None)["dry_run"]
