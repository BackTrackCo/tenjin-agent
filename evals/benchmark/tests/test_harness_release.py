"""A moving registry tag cannot change a run, image identity or resumed checkpoint."""
import copy
import json
from pathlib import Path

import pytest

from evals.benchmark import FIXTURES, checkpoint, cli, harness_release as release, images, manifest, schedule

SOURCE = FIXTURES / "fake" / "manifest.json"
INTEGRITY = "sha512-" + "A" * 86 + "=="


def metadata(*args):
    return {"version": "2.1.270", "dist.integrity": INTEGRITY}


def test_resolve_once_and_load_keeps_fixture_paths_and_image_pin(tmp_path):
    path = tmp_path / "lock.json"
    calls = []
    def fetch(*args):
        calls.append(args)
        return metadata()
    receipt = release.resolve(SOURCE, path, fetch=fetch)
    before = path.read_bytes()
    release.resolve(SOURCE, path, fetch=lambda *args: pytest.fail("resume queried registry"))
    assert len(calls) == 1 and path.read_bytes() == before
    locked, source = manifest.load(path), manifest.load(SOURCE)
    assert locked.release == receipt["release"]
    assert locked.fixture_path(locked.tasks[0]) == source.fixture_path(source.tasks[0])
    assert images.build_args(locked.pins)["AGENT_VERSION"] == "2.1.270"
    assert locked.hash != source.hash
    assert not str(SOURCE.parent) in before.decode()


@pytest.mark.parametrize("change", [
    {"version": "latest"}, {"version": "2.1.270-beta"}, {"version": "$(touch /tmp/never)"},
    {"dist.integrity": "wrong"}, {"version": None},
])
def test_invalid_registry_receipts_never_write_a_lock(tmp_path, change):
    path = tmp_path / "lock.json"
    with pytest.raises(manifest.ManifestError):
        release.resolve(SOURCE, path, fetch=lambda *args: {**metadata(), **change})
    assert not path.exists()


def test_explicit_pin_and_checkpoint_restore_need_no_new_lookup(tmp_path):
    first, second = tmp_path / "first.json", tmp_path / "second.json"
    release.resolve(SOURCE, first, version="2.1.270", fetch=metadata)
    release.resolve(SOURCE, second, from_lock=first, fetch=lambda *args: pytest.fail("checkpoint queried registry"))
    assert first.read_bytes() == second.read_bytes()
    with pytest.raises(manifest.ManifestError, match="another requested"):
        release.resolve(SOURCE, first, version="2.1.271", fetch=metadata)


def test_resolution_preserves_exact_run_checkpoint_and_report(tmp_path):
    lock, run = tmp_path / "lock.json", tmp_path / "run"
    release.resolve(SOURCE, lock, fetch=metadata)
    config = manifest.load(lock)
    cli.run_nonce(run, config)
    schedule.write(run, config, schedule.expand(config))
    report = cli.do_report(run)
    assert report["run_configuration"]["harness_release"]["version"] == "2.1.270"
    bundle, restored = tmp_path / "bundle", tmp_path / "restored"
    checkpoint.export_run(run, bundle, lock, "a" * 40)
    assert (bundle / "harness-lock.json").is_file()
    checkpoint.import_run(bundle, restored, lock, "a" * 40)
    lock.unlink()
    loaded, _ = cli.load_run(restored)
    assert loaded.hash == config.hash and loaded.release == config.release


def test_changed_source_and_package_redirect_are_refused(tmp_path):
    path = tmp_path / "lock.json"
    release.resolve(SOURCE, path, fetch=metadata)
    data = json.loads(path.read_text())
    for key, value in (("source_hash", "bad"), ("source", "../outside.json")):
        changed = {**data, key: value}
        with pytest.raises(manifest.ManifestError):
            release.load_lock(changed, path)
    for key, value in (("package", "attacker"), ("registry", "https://attacker.invalid")):
        changed = copy.deepcopy(data)
        changed["release"][key] = value
        with pytest.raises(manifest.ManifestError):
            release.load_lock(changed, path)


def test_integrity_is_part_of_manifest_and_image_identity(tmp_path):
    path = tmp_path / "lock.json"
    data = release.resolve(SOURCE, path, fetch=metadata)
    first = manifest.load(path)
    data["release"]["integrity"] = "sha512-" + "B" * 86 + "=="
    second = release.load_lock(data, path)
    assert first.hash != second.hash
    assert images.build_args(first.pins)["AGENT_INTEGRITY"] != images.build_args(second.pins)["AGENT_INTEGRITY"]


def test_registry_client_runs_outside_project_and_without_credentials(monkeypatch):
    from types import SimpleNamespace
    import subprocess
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "must-not-leak")
    def run(command, **kwargs):
        assert Path(kwargs["cwd"]) == Path(kwargs["env"]["HOME"])
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in kwargs["env"]
        assert "--@openai:registry=" + release.REGISTRY in command
        assert "--@anthropic-ai:registry=" + release.REGISTRY in command
        return SimpleNamespace(returncode=0, stdout=json.dumps(metadata()))
    monkeypatch.setattr(subprocess, "run", run)
    assert release.metadata("@openai/codex", "latest") == metadata()
