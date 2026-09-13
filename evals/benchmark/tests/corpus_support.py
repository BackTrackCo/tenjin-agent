"""Assertions over the reusable fixture library."""
from __future__ import annotations
import json
import os
import re
from pathlib import Path
from evals.benchmark import REPO_ROOT

EXACT_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
# Files a run leaves behind. A frozen fixture carries none of them.
RUN_ARTEFACTS = (
    ".bench1",
    "node_modules/.vite",
    "node_modules/.vite-temp",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm",
    "node_modules/.package-map.json",
    "node_modules/.pnpm-workspace-state-v1.json",
)
# The guard in every fixture's vitest config: a runner that did not come
# through pnpm is refused for a repository reason, in words that name the
# convention and never the command that satisfies it.
PNPM_GUARD = "process.env.npm_config_user_agent"
# A base64 run long enough to be a payload, which a frozen fixture never holds.
BLOB = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
PNPM_GUARD_MESSAGE = "this repository's tests run through pnpm; see the repository convention"


def link_workspace_packages(repo: Path) -> list[str]:
    """The workspace links `pnpm install` would make, for a check that runs without the image.

    A fixture commits no `node_modules` and the installed tree comes out of the
    task's image, but a workspace fixture's hidden test resolves its package by
    specifier. This is the one link that resolution goes through and none of
    the dependency tree, so an offline case can judge the fixture.
    """
    made = []
    for manifest in sorted(repo.glob("packages/*/package.json")):
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        if not name:
            continue
        link = repo / "node_modules" / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(manifest.parent, link.parent))
        made.append(str(name))
    return made


def assert_vitest_fixture(fixture: Path, task: str, *, trap: bool = True, package_dir: str = "", test_ext: str = "mjs") -> None:
    """A live task fixture is a real Vitest project that commits none of its toolchain.

    Its dependency tree is the image's: `pnpm install` ran there at build time,
    so the fixture states the runner it pins and nothing about how it is
    installed. No lockfile, no `.npmrc`, no `node_modules`, no vendored
    archive. `trap` is the Bench-0 family's barrier (the wrapper script, the
    pnpm guard, the failing shards); a Bench-2 family carries its own real
    failure instead and no barrier. `package_dir` is the workspace package the
    tests live in.
    """
    root = json.loads((fixture / "package.json").read_text(encoding="utf-8"))
    pinned = root["devDependencies"]["vitest"]
    assert EXACT_VERSION.match(pinned), pinned
    for absent in ("pnpm-lock.yaml", ".npmrc", "node_modules"):
        assert not (fixture / absent).exists(), f"{task} commits {absent}, which the image owns"
    project = fixture / package_dir if package_dir else fixture
    package = json.loads((project / "package.json").read_text(encoding="utf-8"))
    config = (project / "vitest.config.mjs").read_text(encoding="utf-8")
    assert f"['./scripts/ran-marker.mjs', {{ task: '{task}' }}]" in config
    assert "pnpm exec" not in config
    if trap:
        # The trap: the package script is a wrapper, and the wrapper never reads its arguments.
        assert package["scripts"]["test"] == "node scripts/all-tests.mjs"
        assert "argv" not in (project / "scripts" / "all-tests.mjs").read_text(encoding="utf-8")
        assert "'unrelated/**/*.test.mjs'" in config
        assert PNPM_GUARD in config
        assert PNPM_GUARD_MESSAGE in config
        assert list((project / "unrelated").glob("*.test.mjs"))
    else:
        assert PNPM_GUARD not in config
        assert not (project / "unrelated").exists()
        assert not (project / "scripts" / "all-tests.mjs").exists()
    # pnpm 11 reads its settings from pnpm-workspace.yaml and, without this,
    # runs an install before the first `pnpm exec` or `pnpm run` in a fresh
    # tree: a registry download the trial must never make.
    workspace = (fixture / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    assert "verifyDepsBeforeRun: false" in workspace
    assert "nodeLinker: hoisted" in workspace
    # The named test is a vitest test, so plain `node` cannot run it, and its cases come from the
    # runner's setup file: nothing in the tree holds them, decodable or not.
    test = (project / "tests" / f"{task}.test.{test_ext}").read_text(encoding="utf-8")
    assert "from 'vitest'" in test
    assert "globalThis.__bench1Cases" in test
    assert "setupFiles: ['./.bench1/cases.setup.mjs']" in config
    assert not (project / "tests" / "support").exists()
    hidden = REPO_ROOT / "evals" / "benchmark" / "hidden" / task / "cases.json"
    assert hidden.is_file(), f"hidden/{task}/cases.json holds the expected values"
    # Values of three characters or more, matched as whole tokens, so a bare digit or a word inside
    # an identifier is not "revealed"; the source under test is skipped, since the fix's own tokens
    # (an enum member, a unit) live there.
    expected = {str(entry["expected"]) for entry in json.loads(hidden.read_text(encoding="utf-8")) if len(str(entry["expected"])) >= 3}
    for path in fixture.rglob("*"):
        if path.is_file() and "node_modules" not in path.parts:
            text = path.read_text(encoding="utf-8", errors="replace")
            # The lockfile's integrity hashes are base64 by design and name no expected value.
            if path.name != "pnpm-lock.yaml":
                assert BLOB.search(text) is None, f"{path.relative_to(fixture)} holds a decodable blob"
            if "src" in path.relative_to(fixture).parts:
                continue
            for value in expected:
                assert re.search(r"(?<![A-Za-z0-9])" + re.escape(value) + r"(?![A-Za-z0-9])", text) is None, f"{path.relative_to(fixture)} reveals an expected value"
    for artefact in RUN_ARTEFACTS:
        assert not (fixture / artefact).exists(), artefact
        assert not (project / artefact).exists(), artefact
    assert [path for path in fixture.rglob("*") if path.is_symlink()] == []
