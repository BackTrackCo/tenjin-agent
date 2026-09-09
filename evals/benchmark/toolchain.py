"""The package manager a trial runs, made deterministic and offline.

A fixture runs its tests through `pnpm`, which comes from the inherited
`PATH`. On the operator's machine that `pnpm` is a corepack shim, and corepack
keeps its cache under `HOME`; every trial gets a fresh `HOME`, so the first
`pnpm` command of every trial fetched the latest pnpm from the registry before
any test ran. Three runs of the hooks smoke were not offline for that reason.

This module closes that: each fixture pins `packageManager` in its
`package.json`, the child gets `COREPACK_HOME` pointed at a per-trial copy of
exactly the pinned version out of the operator's cache (19 MB, against 194 MB
for the whole cache) and `COREPACK_ENABLE_NETWORK=0`, so a shim resolves the
pin without a lookup and a missing version fails fast instead of fetching. A
live run is refused up front when the `pnpm` that would run cannot be the
pinned one: a shim with no cached copy of the pin, or a binary of another
version, which pnpm would answer by fetching the pinned one itself. What ran
goes into the record's isolation block as `package_manager`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

PNPM = "pnpm"
COREPACK_HOME_VAR = "COREPACK_HOME"
COREPACK_NETWORK_VAR = "COREPACK_ENABLE_NETWORK"
COREPACK_CACHE = ("v1", PNPM)
DEFAULT_COREPACK_HOME = (".cache", "node", "corepack")
SHIM_MARKER = b"corepack"
SHIM_LINES = 8
KINDS = frozenset({"corepack-shim", "binary", "missing"})
PIN = re.compile(r"^pnpm@(?P<version>\d+\.\d+\.\d+)\Z")
VERSION_TIMEOUT_S = 10


class ToolchainError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class PackageManager:
    """The `pnpm` the child would run: what it is, which version, and what corepack has cached."""

    kind: str
    path: str | None
    version: str | None
    cached: tuple[str, ...] = ()

    @property
    def facts(self) -> dict[str, Any]:
        return {"kind": self.kind, "version": self.version}


def package_manager_pin(fixture: Path) -> str | None:
    """The pnpm version `package.json` pins, or None when the fixture has no package.json."""
    package = fixture / "package.json"
    if not package.is_file():
        return None
    try:
        data = json.loads(package.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ToolchainError("pin_unreadable", f"{fixture.name}/package.json: {error.__class__.__name__}") from error
    if not isinstance(data, dict) or "packageManager" not in data:
        raise ToolchainError("pin_missing", f"{fixture.name}/package.json pins no packageManager; add \"packageManager\": \"pnpm@<version>\"")
    match = PIN.match(str(data["packageManager"]))
    if match is None:
        raise ToolchainError("pin_shape", f"{fixture.name}/package.json packageManager must be pnpm@<major.minor.patch>")
    return match.group("version")


def corepack_home(environ: Mapping[str, str]) -> Path:
    """Where corepack keeps its cache for the operator: `COREPACK_HOME`, else `~/.cache/node/corepack`."""
    configured = environ.get(COREPACK_HOME_VAR)
    if configured:
        return Path(configured)
    return Path(environ.get("HOME") or Path.home()).joinpath(*DEFAULT_COREPACK_HOME)


def cached_versions(home: Path) -> tuple[str, ...]:
    cache = home.joinpath(*COREPACK_CACHE)
    if not cache.is_dir():
        return ()
    return tuple(sorted(entry.name for entry in cache.iterdir() if entry.is_dir() and (entry / "package.json").is_file()))


def resolve(environ: Mapping[str, str]) -> Path | None:
    found = shutil.which(PNPM, path=environ.get("PATH", ""))
    return None if found is None else Path(found)


def kind_of(binary: Path) -> str:
    """A shim's first lines name corepack (the download prompt variable, then `corepack.cjs`); anything else is pnpm itself."""
    try:
        with binary.open("rb") as handle:
            head = b"".join(handle.readline() for _ in range(SHIM_LINES))
    except OSError:
        return "missing"
    return "corepack-shim" if SHIM_MARKER in head.lower() else "binary"


def binary_version(binary: Path, environ: Mapping[str, str], cwd: Path) -> str | None:
    """`pnpm --version` of a real binary, from a directory with no package.json so no pin can redirect it."""
    try:
        completed = subprocess.run(
            [str(binary), "--version"],
            cwd=cwd,
            env={"PATH": environ.get("PATH", ""), "HOME": environ.get("HOME", ""), COREPACK_NETWORK_VAR: "0"},
            capture_output=True,
            text=True,
            timeout=VERSION_TIMEOUT_S,
            shell=False,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and re.match(r"^\d+\.\d+\.\d+\Z", value) else None


def inspect(environ: Mapping[str, str], pin: str | None, *, probe_binary: bool, cwd: Path) -> PackageManager:
    """What `pnpm` on this PATH is. A binary's version costs one child process, so a dry run skips it."""
    binary = resolve(environ)
    if binary is None:
        return PackageManager(kind="missing", path=None, version=None)
    kind = kind_of(binary)
    if kind == "corepack-shim":
        cached = cached_versions(corepack_home(environ))
        return PackageManager(kind=kind, path=str(binary), version=pin if pin in cached else None, cached=cached)
    version = binary_version(binary, environ, cwd) if probe_binary else None
    return PackageManager(kind=kind, path=str(binary), version=version)


def check(manager: PackageManager, pin: str, home: Path) -> None:
    """Refuse unless the `pnpm` that would run is exactly the pinned one, naming the fix."""
    if manager.kind == "missing":
        raise ToolchainError("pnpm_missing", "no pnpm on PATH; the fixture runs its tests through pnpm")
    if manager.kind == "corepack-shim":
        if pin not in manager.cached:
            cached = ", ".join(manager.cached) or "nothing"
            raise ToolchainError(
                "pnpm_uncached",
                f"pnpm on PATH is a corepack shim and {home} caches {cached}, not the pinned {pin}; "
                f"run `corepack install -g pnpm@{pin}` once with network, or put a pnpm {pin} binary first on PATH",
            )
        return
    if manager.version != pin:
        found = manager.version or "an unknown version"
        raise ToolchainError(
            "pnpm_version",
            f"pnpm on PATH is {found} and the fixture pins {pin}, which pnpm would fetch on first use; put a pnpm {pin} binary first on PATH",
        )


def seed(source: Path, destination: Path, version: str) -> Path:
    """Copy one cached pnpm version into the trial's own corepack home, and nothing else."""
    cached = source.joinpath(*COREPACK_CACHE, version)
    target = destination.joinpath(*COREPACK_CACHE, version)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(cached, target, symlinks=False)
    return destination


def child_variables(destination: Path) -> dict[str, str]:
    """What the child gets: its own corepack home and no network for corepack."""
    return {COREPACK_HOME_VAR: os.path.abspath(destination), COREPACK_NETWORK_VAR: "0"}
