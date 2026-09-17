"""Disposable root outputs for the supported historical JS toolchains.

This controller-owned list is shared by source admission and both staging
steps. Never consult the submitted .gitignore: it cannot expand permissions.
Historical fixtures cannot contain these reserved outputs, so discarding them
cannot conceal changes to original tracked source. Nested product paths remain
subject to the normal source contract.
"""
from fnmatch import fnmatchcase
from pathlib import Path

ROOT_PATTERNS = (
    "node_modules", ".pnpm-store", "dist", ".next", "out", "build",
    "coverage", "storybook-static", ".eslintcache", ".prettiercache",
    "vitest-report.json", "*.tsbuildinfo", "*.log", "*.tgz",
)


def contains(relative: str) -> bool:
    root = relative.split("/", 1)[0]
    return any(fnmatchcase(root, pattern) for pattern in ROOT_PATTERNS)


def names(repo: Path) -> list[str]:
    return sorted(entry.name for entry in repo.iterdir() if contains(entry.name))
