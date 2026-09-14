from pathlib import Path
from types import SimpleNamespace

import pytest

from evals.benchmark import container, container_verifier, verifier

IMAGE = "sha256:" + "ab" * 32


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "run" / "trials" / "one" / "verify"
    path.mkdir(parents=True)
    (path / "hidden-tests").mkdir()
    (path / "hidden-tests" / "actor.test.mjs").write_text("// code-owned oracle placeholder")
    return path


def stub(monkeypatch, *, code=0, error=None, cleanup=True):
    seen = []
    class Running:
        # Required, not optional: the container republishes the attempt's
        # project line through it once the project exists.
        def __init__(self, *, recipe, ledger):
            assert isinstance(ledger, container.Ledger)
            seen.append(recipe)
        def __enter__(self):
            return self
        def __exit__(self, *_):
            seen.append("closed")
        def exec(self, argv, **kwargs):
            seen.append((argv, kwargs))
            if error:
                raise error
            return SimpleNamespace(returncode=code, stdout="", stderr="")
    monkeypatch.setattr(container, "Container", Running)
    def remove_project(_):
        if isinstance(cleanup, Exception):
            raise cleanup
        return cleanup
    monkeypatch.setattr(container, "remove_project", remove_project)
    return seen


@pytest.mark.parametrize("removed", [False, True])
def test_hidden_source_uses_only_pinned_image_readonly_copy_and_no_network(repo, monkeypatch, removed):
    seen = stub(monkeypatch, cleanup=removed)
    spec = verifier.node_test_spec("actor")
    # The model's green marker is checked independently of its hidden test.
    monkeypatch.setattr(verifier, "check_marker", lambda *_: None)
    run = repo.parents[2]
    result = verifier.run(spec, repo, run, image=IMAGE)
    assert result.outcome == "pass"
    assert verifier.facts(result)["runtime"] == {"kind": "container", "image": IMAGE}
    recipe = seen[0]
    assert recipe.image == IMAGE
    assert recipe.egress.mode == container.NO_NETWORK
    assert recipe.forward == () and not recipe.daemon
    assert recipe.plan == [container.Mount(repo.resolve(), Path("/benchmark-verify"), "ro")]
    assert recipe.environment == {"HOME": "/tmp", "BENCH2_DAEMON": "", "BENCH2_OUTPUT": "/tmp/benchmark-verifier"}
    assert seen[1][0] == ["node", "/benchmark-verify/hidden-tests/actor.test.mjs"]
    assert seen[1][1]["timeout_s"] == spec.timeout_s
    assert "closed" in seen
    assert list((run / "projects").glob("*.project")) == []


@pytest.mark.parametrize("image", [None, "latest", "node:24"])
def test_no_host_fallback_or_mutable_image(repo, monkeypatch, image):
    monkeypatch.setattr(container, "Container", lambda **_: pytest.fail("must not launch"))
    monkeypatch.setattr(verifier.subprocess, "run", lambda *_a, **_k: pytest.fail("must not execute source on host"))
    assert verifier.run(verifier.node_test_spec("actor"), repo, repo.parents[2], image=image).outcome == "invalid"


def test_hidden_failure_and_missing_green_marker_stay_task_failures(repo, monkeypatch):
    stub(monkeypatch, code=1)
    spec = verifier.node_test_spec("actor")
    assert verifier.run(spec, repo, repo.parents[2], image=IMAGE).outcome == "fail"
    stub(monkeypatch, code=0)
    result = verifier.run(spec, repo, repo.parents[2], image=IMAGE)
    assert result.outcome == "fail" and "run marker" in result.detail


def test_timeout_and_cleanup_failure_are_invalid_and_keep_cleanup_ownership(repo, monkeypatch):
    seen = stub(monkeypatch, error=TimeoutError("host detail"), cleanup=container.ImageError("cleanup_failed", "cannot list objects"))
    result = verifier.run(verifier.node_test_spec("actor"), repo, repo.parents[2], image=IMAGE)
    assert result.outcome == "invalid"
    assert "cleanup failed" in result.detail and "host detail" not in result.detail
    assert "closed" in seen
    assert len(list((repo.parents[2] / "projects").glob("*.project"))) == 1


def test_missing_hidden_oracle_is_invalid_before_container_launch(repo, monkeypatch):
    (repo / "hidden-tests" / "actor.test.mjs").unlink()
    monkeypatch.setattr(container, "Container", lambda **_: pytest.fail("missing oracle must not launch"))
    result = verifier.run(verifier.node_test_spec("actor"), repo, repo.parents[2], image=IMAGE)
    assert result.outcome == "invalid" and "missing" in result.detail
