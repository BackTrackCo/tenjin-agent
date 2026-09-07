"""Disposable trial roots.

Every trial owns fresh home, profile, TENJIN_DATA_DIR, repository, and output
roots under the run directory. The verifier's copy of the worktree is made
only after the agent has stopped, so hidden verifier bytes are never on the
agent-visible mount. A temp directory is not a sandbox; the live-run
isolation attestation is a later step.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TrialRoots:
    base: Path
    home: Path
    profile: Path
    data_dir: Path
    repo: Path
    output: Path

    @property
    def verify(self) -> Path:
        return self.base / "verify"

    def environment(self, path: str) -> dict[str, str]:
        return {
            "PATH": path,
            "HOME": str(self.home),
            "TENJIN_DATA_DIR": str(self.data_dir),
            "TENJIN_PUBLISH_MODE": "review",
            "CLAUDE_CONFIG_DIR": str(self.profile),
        }

    def hidden_copy(self) -> Path:
        """Copy the final worktree for the verifier; call only after shutdown."""
        if self.verify.exists():
            shutil.rmtree(self.verify)
        shutil.copytree(self.repo, self.verify, symlinks=False)
        return self.verify


def create(run_dir: Path, trial_id: str, fixture: Path) -> TrialRoots:
    base = run_dir / "trials" / trial_id
    if base.exists():
        shutil.rmtree(base)
    roots = TrialRoots(
        base=base,
        home=base / "home",
        profile=base / "profile",
        data_dir=base / "data",
        repo=base / "repo",
        output=base / "output",
    )
    for path in (roots.home, roots.profile, roots.data_dir, roots.output):
        path.mkdir(parents=True)
    shutil.copytree(fixture, roots.repo, symlinks=False)
    return roots
