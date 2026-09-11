"""Fixtures the offline self-test shares.

What lives here is what more than one module needs: the parsed fixture
sessions, one built fake corpus, one finished fake run, and the registry
cleanup every module that registers an executor used to write by hand.
Anything a single module needs stays in that module.
"""

from __future__ import annotations

import contextlib
import io
import shutil
from pathlib import Path
from typing import Any, Callable, Iterator

import pytest

from evals.benchmark import claude_usage, cli, executor, manifest as manifest_module, records
from evals.benchmark.records import Excluded
from evals.benchmark.tests import support

Corpus = tuple[manifest_module.Manifest, str, dict[str, Any], list[Excluded]]


@pytest.fixture(scope="session")
def family_session() -> claude_usage.SessionUsage:
    return support.parse("sess-family")


@pytest.fixture(scope="session")
def root_only_session() -> claude_usage.SessionUsage:
    return support.parse("sess-root-only")


@pytest.fixture(scope="session")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> Corpus:
    """A finished offline run: 12 attempts over 3 tasks, 2 arms, 2 repeats.

    Built once for every module that reduces or projects it, and read only.
    """
    manifest, digest, records_dir = support.fake_corpus(tmp_path_factory.mktemp("corpus"))
    accepted, excluded = records.select(records_dir, manifest.hash, digest)
    return manifest, digest, accepted, excluded


@pytest.fixture(scope="session")
def _finished_run(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("fake-run") / "run"
    with contextlib.redirect_stdout(io.StringIO()):
        cli.fake_run(out)
    return out


@pytest.fixture
def fake_run(_finished_run: Path, tmp_path: Path) -> Path:
    """The finished run, copied, so a case may write into its own."""
    out = tmp_path / "run"
    shutil.copytree(_finished_run, out, symlinks=True)
    return out


@pytest.fixture
def register_executor() -> Iterator[Callable[[str, executor.ExecutorSpec], str]]:
    """Register a spec for one case; the registry is restored either way."""
    names: list[str] = []

    def register(name: str, spec: executor.ExecutorSpec) -> str:
        executor.REGISTRY[name] = spec
        names.append(name)
        return name

    yield register
    for name in names:
        executor.REGISTRY.pop(name, None)


@pytest.fixture(autouse=True)
def generated_live_inputs(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Infrastructure tests do not read the experiment's manifests or corpus."""
    if request.module.__name__.rsplit(".", 1)[-1] not in {"test_claude_live", "test_tenjin_arm", "test_toolchain"}:
        return
    smoke, hooks = support.generated_live_inputs(tmp_path / "live-inputs")
    monkeypatch.setattr(request.module, "SMOKE_MANIFEST", smoke, raising=False)
    monkeypatch.setattr(request.module, "HOOKS_SMOKE_MANIFEST", hooks, raising=False)
