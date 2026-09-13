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
