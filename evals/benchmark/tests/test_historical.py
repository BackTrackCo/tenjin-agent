"""Historical readiness admission: source identity, no host execution, real assertions."""
import io
import json
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from evals.benchmark import container, images, sha256_dir, sha256_file
from evals.benchmark import historical as replay


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as stream:
        for name, payload in entries:
            member = tarfile.TarInfo(name)
            if payload is None:
                member.type, member.linkname = tarfile.SYMTYPE, "/host/private"
                stream.addfile(member)
            else:
                member.size = len(payload)
                stream.addfile(member, io.BytesIO(payload))
    return out.getvalue()


@pytest.mark.parametrize("entry", [("../escape", b"x"), ("/absolute", b"x"), ("source/link", None)])
def test_archive_refuses_traversal_absolute_paths_and_links(tmp_path, entry):
    with pytest.raises(replay.ReplayError):
        replay.unpack(archive([entry]), tmp_path / "source")
    assert not (tmp_path / "escape").exists()


def test_archive_keeps_source_but_omits_installed_hooks_and_automation(tmp_path):
    replay.unpack(archive([("src/code.ts", b"source"), (".claude/settings.json", b"hook"), (".github/workflows/ci.yml", b"workflow")]), tmp_path)
    assert (tmp_path / "src/code.ts").read_bytes() == b"source"
    assert not (tmp_path / ".claude").exists() and not (tmp_path / ".github").exists()


def test_catalog_rejects_unknown_task_and_shell_shaped_name(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"tasks": []}))
    for name in ["unknown", "fixture; echo injected", "../fixture"]:
        with pytest.raises(replay.ReplayError):
            replay.task_named(name, catalog)


@pytest.fixture
def context(tmp_path, monkeypatch):
    root = tmp_path / "definitions"
    (root / "oracles").mkdir(parents=True)
    for path in [root / "oracles" / "fixture.test.ts", root / "Dockerfile", root / "vitest.config.mjs", root / "database.mjs"]:
        path.write_text("code-owned")
    monkeypatch.setattr(replay, "ROOT", root)
    out = tmp_path / "prepared"
    (out / "source").mkdir(parents=True)
    (out / "source" / "pnpm-lock.yaml").write_text("frozen-lock")
    for src, dest in [(root / "oracles/fixture.test.ts", out / "oracle.test.ts"), (root / "Dockerfile", out / "Dockerfile"), (root / "vitest.config.mjs", out / "vitest.config.mjs"), (root / "database.mjs", out / "database.mjs")]:
        dest.write_bytes(src.read_bytes())
    task = {"id": "fixture", "before_commit": "a" * 40, "after_commit": "b" * 40, "trees": {"before": "c" * 40, "after": "d" * 40}, "lock_sha256": sha256_file(out / "source/pnpm-lock.yaml"), "oracle": "fixture.test.ts"}
    catalog = root / "catalog.json"
    catalog.write_text(json.dumps({"tasks": [task]}))
    monkeypatch.setattr(replay, "task_named", lambda *_: task)
    receipt = {"catalog_sha256": sha256_file(catalog), "task": "fixture", "revision": "before", "commit": "a" * 40, "tree": "c" * 40, "source_hash": sha256_dir(out / "source")}
    (out / "source-receipt.json").write_text(json.dumps(receipt))
    return out


@pytest.mark.parametrize("path", ["source/pnpm-lock.yaml", "oracle.test.ts", "Dockerfile", "vitest.config.mjs", "database.mjs"])
def test_context_drift_refuses_before_image_execution(context, path):
    (context / path).write_text("drift")
    with pytest.raises(replay.ReplayError):
        replay.validate_context(context, catalog=replay.ROOT / "catalog.json")


def test_existing_output_is_never_overwritten(context, monkeypatch):
    monkeypatch.setattr(images, "run_git", lambda *_: "c" * 40)
    monkeypatch.setattr(replay.subprocess, "run", lambda *_a, **_k: pytest.fail("must refuse before archiving"))
    with pytest.raises(replay.ReplayError, match="new output"):
        replay.prepare(Path("unused"), "fixture", "before", context, catalog=replay.ROOT / "catalog.json")


def image_backend(monkeypatch, image):
    async def platform():
        return "linux/arm64"
    monkeypatch.setattr(images, "harbor", lambda: SimpleNamespace(platform=platform, context_hash=lambda **_: "bound-context", name=lambda *_: "bound-name"))
    monkeypatch.setattr(images, "image_id", lambda _: image)


def test_wrong_image_is_refused_before_container_creation(context, monkeypatch, tmp_path):
    image_backend(monkeypatch, "sha256:" + "1" * 64)
    monkeypatch.setattr(container, "Container", lambda **_: pytest.fail("must not launch"))
    with pytest.raises(replay.ReplayError, match="image does not match"):
        replay.verify(context, tmp_path / "run", "sha256:" + "2" * 64, catalog=replay.ROOT / "catalog.json")


@pytest.mark.parametrize("total,failed,assertions,runtime_errors,expected", [
    (0, 0, [], 1, "invalid"),
    (1, 1, [{"fullName": "independent contract", "status": "failed"}], 0, "fail"),
    (1, 0, [{"fullName": "independent contract", "status": "passed"}], 0, "pass"),
    (1, 1, [], 0, "invalid"),
    (1, 0, [{"status": "pending"}], 0, "invalid"),
    (1, 0, [{"status": "todo"}], 0, "invalid"),
    (1, 0, [{"status": "failed"}], 0, "invalid"),
    (1, 1, [{"fullName": "independent contract", "status": "failed"}], 1, "invalid"),
])
def test_only_completed_assertions_establish_fail_before_or_pass_after(context, tmp_path, monkeypatch, total, failed, assertions, runtime_errors, expected):
    image = "sha256:" + "1" * 64
    image_backend(monkeypatch, image)
    report = {"numTotalTests": total, "numFailedTests": failed, "numPassedTests": total - failed, "numRuntimeErrorTestSuites": runtime_errors, "success": not failed and not runtime_errors, "testResults": [{"assertionResults": assertions}]}
    seen = []
    class Running:
        def __init__(self, *, recipe):
            seen.append(recipe)
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def exec(self, argv, **_):
            if argv[0] == "cat":
                return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")
            assert argv == replay.COMMAND
            return SimpleNamespace(returncode=int(failed > 0 or runtime_errors > 0), stdout="", stderr="")
    monkeypatch.setattr(container, "Container", Running)
    monkeypatch.setattr(container, "remove_project", lambda _: False)
    result = replay.verify(context, tmp_path / "run", image, catalog=replay.ROOT / "catalog.json")
    assert result["status"] == expected and result["cleanup"]
    assert seen[0].plan == [] and seen[0].forward == ()
    assert seen[0].egress.mode == container.NO_NETWORK
    assert list((tmp_path / "run/projects").glob("*.project")) == []


def test_changed_experiment_catalog_refuses_prepared_context(context):
    catalog = replay.ROOT / "catalog.json"
    catalog.write_text(json.dumps({"tasks": [], "changed": True}))
    with pytest.raises(replay.ReplayError, match="catalog changed"):
        replay.validate_context(context, catalog=catalog)
