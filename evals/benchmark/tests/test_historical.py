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
    task["source_hashes"] = {revision: sha256_dir(out / "source") for revision in replay.REVISION}
    catalog = root / "catalog.json"
    catalog.write_text(json.dumps({"tasks": [task]}))
    monkeypatch.setattr(replay, "task_named", lambda *_: task)
    receipt = {"catalog_sha256": sha256_file(catalog), "task_sha256": replay.sha256_json(task), "task": "fixture", "revision": "before", "commit": "a" * 40, "tree": "c" * 40, "source_hash": sha256_dir(out / "source")}
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
    if runtime_errors:
        report["testResults"][0]["message"] = "fixture setup refused invalid synthetic configuration"
    seen = []
    class Running:
        # `ledger` is required here on purpose: the container republishes the
        # attempt's project line through it once the project exists, so a call
        # site that stopped passing one fails this case rather than a live run.
        def __init__(self, *, recipe, ledger):
            assert isinstance(ledger, container.Ledger)
            seen.append(recipe)
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def exec(self, argv, **_):
            if argv[0] == "cat":
                return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")
            assert argv == replay.COMMAND
            return SimpleNamespace(returncode=int(failed > 0 or runtime_errors > 0), stdout="startup diagnostic", stderr="JSON report written")
    monkeypatch.setattr(container, "Container", Running)
    monkeypatch.setattr(container, "remove_project", lambda _: False)
    result = replay.verify(context, tmp_path / "run", image, catalog=replay.ROOT / "catalog.json")
    assert result["status"] == expected and result["cleanup"]
    assert "startup diagnostic" in result["detail"] and "JSON report written" in result["detail"]
    if runtime_errors:
        assert result["suite_errors"] == ["fixture setup refused invalid synthetic configuration"]
    assert seen[0].plan == [] and seen[0].forward == ()
    assert seen[0].egress.mode == container.NO_NETWORK
    assert list((tmp_path / "run/projects").glob("*.project")) == []
    replay.verify(context, tmp_path / "run", image, catalog=replay.ROOT / "catalog.json")
    assert seen[0].name != seen[1].name
    assert len(list((tmp_path / "run").glob("replay-*.json"))) == 2


def test_changed_experiment_task_refuses_prepared_context(context):
    catalog = replay.ROOT / "catalog.json"
    replay.task_named("fixture", catalog)["prompt"] = "different assignment"
    with pytest.raises(replay.ReplayError, match="task changed"):
        replay.validate_context(context, catalog=catalog)


def test_unrelated_catalog_addition_preserves_prepared_task(context):
    catalog = replay.ROOT / "catalog.json"
    data = json.loads(catalog.read_text())
    data["tasks"].append({"id": "unrelated-new-task"})
    catalog.write_text(json.dumps(data))
    receipt = replay.validate_context(context, catalog=catalog)
    assert receipt["catalog_sha256"] != sha256_file(catalog)


def test_coordinated_source_and_receipt_tamper_is_refused(context):
    (context/'source/injected.ts').write_text('different historical implementation')
    path = context/'source-receipt.json'
    receipt = json.loads(path.read_text())
    receipt['source_hash'] = sha256_dir(context/'source')
    path.write_text(json.dumps(receipt))
    with pytest.raises(replay.ReplayError, match='historical source'):
        replay.validate_context(context, catalog=replay.ROOT/'catalog.json')


def test_failed_preparation_cleans_only_its_new_output_and_can_retry(context, monkeypatch, tmp_path):
    monkeypatch.setattr(images, 'run_git', lambda *_: 'c'*40)
    valid = archive([('pnpm-lock.yaml', b'frozen-lock')])
    payloads = iter([archive([('../escape', b'bad')]), valid])
    monkeypatch.setattr(replay.subprocess, 'run', lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=next(payloads)))
    target = tmp_path/'fresh'
    with pytest.raises(replay.ReplayError, match='escapes'):
        replay.prepare(Path('unused'), 'fixture', 'before', target, catalog=replay.ROOT/'catalog.json')
    assert not target.exists() and context.exists()
    assert replay.prepare(Path('unused'), 'fixture', 'before', target, catalog=replay.ROOT/'catalog.json')['source_hash'] == sha256_dir(target/'source')


def test_link_to_same_bytes_still_refuses_historical_source(context, tmp_path):
    outside = tmp_path/'outside-lock'
    outside.write_bytes((context/'source/pnpm-lock.yaml').read_bytes())
    (context/'source/pnpm-lock.yaml').unlink()
    (context/'source/pnpm-lock.yaml').symlink_to(outside)
    with pytest.raises(replay.ReplayError, match='links'):
        replay.validate_context(context, catalog=replay.ROOT/'catalog.json')


@pytest.mark.parametrize('relative', ['../escape.ts', '/absolute.ts', 'src/tool.test.ts', 'src/package.json', 'src/benchmark-independent.test.ts'])
def test_mutation_cannot_replace_oracle_tooling_or_escape_source(tmp_path, relative):
    file = tmp_path/'mutation.ts'; file.write_text('wrong product implementation')
    with pytest.raises(replay.ReplayError, match='allowed product'):
        replay.mutation_mounts({'allowed_changes':['src/']}, {relative:file})


def test_mutation_mounts_are_read_only_and_receipts_contain_no_host_path(tmp_path):
    file = tmp_path/'mutation.ts';file.write_text('wrong product implementation')
    mounts, hashes = replay.mutation_mounts({'allowed_changes':['src/']}, {'src/product.ts':file})
    assert mounts[0].target == Path('/opt/task/src/product.ts') and mounts[0].mode == 'ro'
    assert hashes == {'src/product.ts':sha256_file(file)}
    link = tmp_path/'link.ts';link.symlink_to(file)
    with pytest.raises(replay.ReplayError, match='regular file'):
        replay.mutation_mounts({'allowed_changes':['src/']}, {'src/product.ts':link})


def test_visible_test_mounts_are_bound_and_do_not_mount_hidden_oracles(tmp_path):
    source = tmp_path / 'context/source/tests/integration'; source.mkdir(parents=True)
    (source / 'ordinary.test.ts').write_text('existing source test')
    mounts, selected, hashes = replay.visible_mounts(tmp_path / 'context', tmp_path / 'support', ('database-support', 'tests/integration/ordinary.test.ts'))
    assert selected == ['tests/integration/bench1-model-database.test.ts', 'tests/integration/ordinary.test.ts']
    assert len(mounts) == 3 and len(hashes) == 3
    assert all('benchmark-independent' not in str(mount.target) for mount in mounts)
    assert all(len(value) == 64 for value in hashes.values())


@pytest.mark.parametrize('selection', [(), ('../escape.test.ts',), ('--config=other',), ('tests/integration/missing.test.ts',)])
def test_visible_test_selection_refuses_missing_or_arbitrary_tooling(tmp_path, selection):
    with pytest.raises(replay.ReplayError, match='focused'):
        replay.visible_mounts(tmp_path / 'context', tmp_path / 'support', selection)
