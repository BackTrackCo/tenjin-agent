"""Vendored fixture toolchains: one archive per platform, extracted into each trial.

A live task fixture is a real Vitest project, and Vitest with its transitive
dependencies is about 780 files. Committing that tree once per fixture made
the pull request unreviewable, so the tree is committed once, as one
deterministic archive under `fixtures/live/vendor/` with a record beside it
that states its digests and the platform it was built for. `artifact.create`
extracts it into `<repo>/node_modules` at trial preparation, offline, and
checks the extracted tree against the recorded digest. A trial's
`node_modules` is derived, never committed; the fixture keeps only the
hand-written `.bin/vitest` shim, and `manifest.fixture_hash` folds the archive
digest in, so a change to either the fixture or the archive changes the hash.

The archive carries darwin-arm64 natives (esbuild, rollup, fsevents), so the
record pins `platform` and `node_abi`, and a live run on any other host is
refused before a root is built rather than failing inside a trial.

`python3 -m evals.benchmark.vendor build|check` is the operator entry; the
rebuild that installs first is `evals/benchmark/scripts/vendor-vitest.sh`.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import platform as platform_module
import re
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Mapping

from . import sha256_file, sha256_json

DIR = "vendor"
TARGET = "node_modules"
RECORD_KEYS = frozenset(
    {"id", "archive", "archive_sha256", "tree_sha256", "files", "platform", "node_abi", "vitest", "lock_sha256", "pnpm"}
)
STRING_KEYS = ("id", "archive", "archive_sha256", "tree_sha256", "platform", "node_abi", "vitest", "lock_sha256", "pnpm")
SUFFIX = ".tar.gz"
# A vendor id names two files beside each other, so it is a bare file-name token.
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# One fixed timestamp for every entry (2026-09-07T00:00:00Z): the archive's
# bytes then depend on the tree's bytes and nothing about when it was packed.
MTIME = 1_757_203_200
NODE = "node"
NODE_TIMEOUT_S = 10


class VendorError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Vendor:
    id: str
    record: dict[str, Any]
    path: Path
    archive: Path

    @property
    def platform(self) -> str:
        return str(self.record["platform"])

    @property
    def node_abi(self) -> str:
        return str(self.record["node_abi"])

    @property
    def archive_sha256(self) -> str:
        return str(self.record["archive_sha256"])

    @property
    def tree_sha256(self) -> str:
        return str(self.record["tree_sha256"])

    @property
    def files(self) -> int:
        return int(self.record["files"])

    @property
    def facts(self) -> dict[str, Any]:
        return {"id": self.id, "platform": self.platform, "node_abi": self.node_abi, "archive_sha256": self.archive_sha256, "files": self.files}


def record_path(base: Path, vendor_id: str) -> Path:
    return base / DIR / f"{vendor_id}.json"


def resolve(base: Path, vendor_id: str) -> Vendor:
    """Read `<base>/vendor/<id>.json` and locate its archive. Nothing is hashed here."""
    if not isinstance(vendor_id, str) or not ID.match(vendor_id):
        raise VendorError("vendor_record", f"vendor id {vendor_id!r} is not a file-name token")
    path = record_path(base, vendor_id)
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VendorError("vendor_record", f"cannot read {path.name}: {error.__class__.__name__}") from error
    if not isinstance(record, dict):
        raise VendorError("vendor_record", f"{path.name} must be a JSON object")
    unknown = sorted(set(record) - RECORD_KEYS)
    missing = sorted(RECORD_KEYS - set(record))
    if unknown or missing:
        detail = f"unknown keys: {', '.join(unknown)}" if unknown else f"missing keys: {', '.join(missing)}"
        raise VendorError("vendor_record", f"{path.name} has {detail}")
    for key in STRING_KEYS:
        if not isinstance(record[key], str) or not record[key].strip():
            raise VendorError("vendor_record", f"{path.name} {key} must be a non-empty string")
    files = record["files"]
    if isinstance(files, bool) or not isinstance(files, int) or files < 1:
        raise VendorError("vendor_record", f"{path.name} files must be a positive integer")
    if record["id"] != vendor_id:
        raise VendorError("vendor_record", f"{path.name} records id {record['id']!r}, not {vendor_id!r}")
    name = record["archive"]
    if Path(name).name != name or not name.endswith(SUFFIX):
        raise VendorError("vendor_record", f"{path.name} archive must be a bare {SUFFIX} file name beside it")
    for key in ("archive_sha256", "tree_sha256"):
        if not record[key].startswith("sha256:"):
            raise VendorError("vendor_record", f"{path.name} {key} must be a sha256 token")
    archive = path.parent / name
    if not archive.is_file():
        raise VendorError("vendor_archive", f"{name} is missing beside {path.name}")
    return Vendor(id=vendor_id, record=record, path=path, archive=archive)


def check_archive(vendor: Vendor) -> str:
    """The archive's digest, which has to be the one its record states."""
    digest = "sha256:" + sha256_file(vendor.archive)
    if digest != vendor.archive_sha256:
        raise VendorError("vendor_archive", f"{vendor.archive.name} is not the archive {vendor.path.name} records")
    return digest


def host_platform() -> str:
    """`<sys.platform>-<machine>` as Python spells it: `darwin-arm64`, `linux-x86_64`."""
    return f"{sys.platform}-{platform_module.machine()}"


@cache
def node_abi(path: str) -> str | None:
    """`process.versions.modules` of the `node` on `path`, or None when there is none."""
    try:
        completed = subprocess.run(
            [NODE, "-p", "process.versions.modules"],
            env={"PATH": path},
            capture_output=True,
            text=True,
            timeout=NODE_TIMEOUT_S,
            shell=False,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value.isdigit() else None


def host_facts(environ: Mapping[str, str] | None = None, *, probe_node: bool = True) -> dict[str, str | None]:
    """This host's platform and, when asked, the ABI of the `node` on PATH (one child process)."""
    facts: dict[str, str | None] = {"platform": host_platform()}
    if probe_node:
        path = (os.environ if environ is None else environ).get("PATH") or os.environ.get("PATH", "")
        facts["node_abi"] = node_abi(path)
    return facts


def check_platform(vendor: Vendor, host: Mapping[str, str | None]) -> None:
    """Refuse a host the archive was not built for. The ABI is compared only when it was probed."""
    if host.get("platform") != vendor.platform:
        raise VendorError("vendor_platform", f"{vendor.id} was built for {vendor.platform}; this host is {host.get('platform')}")
    if "node_abi" in host and host["node_abi"] != vendor.node_abi:
        found = host["node_abi"] or "no node on PATH"
        raise VendorError("vendor_node_abi", f"{vendor.id} was built for node ABI {vendor.node_abi}; this host reports {found}")


def matches(vendor: Vendor, host: Mapping[str, str | None]) -> bool:
    try:
        check_platform(vendor, host)
    except VendorError:
        return False
    return True


def tree_digest(root: Path, names: list[str]) -> str:
    """Sorted relative paths and file digests, the shape `sha256_dir` uses, over named files only."""
    entries = [[name, sha256_file(root / name)] for name in sorted(names)]
    return "sha256:" + sha256_json(entries)


def _members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    """Every member, each a regular file or directory on a relative path that stays inside."""
    members = archive.getmembers()
    for member in members:
        parts = Path(member.name).parts
        if not member.name or Path(member.name).is_absolute() or ".." in parts or member.name.startswith("/"):
            raise VendorError("vendor_member", f"{member.name!r} escapes the archive")
        if not (member.isfile() or member.isdir()):
            raise VendorError("vendor_member", f"{member.name!r} is not a regular file or directory")
    return members


def extract(vendor: Vendor, destination: Path, host: Mapping[str, str | None] | None = None) -> int:
    """Extract the archive into `destination` and verify the tree. Returns the file count."""
    check_platform(vendor, host_facts() if host is None else host)
    check_archive(vendor)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(vendor.archive, "r:gz") as archive:
        members = _members(archive)
        # Python 3.12 (and 3.11.4) extract with the data filter, which refuses
        # links and clears setuid bits; older interpreters get the member check above.
        options: dict[str, Any] = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        archive.extractall(destination, members=members, **options)
    names = [member.name for member in members if member.isfile()]
    if len(names) != vendor.files:
        raise VendorError("vendor_tree", f"{vendor.archive.name} holds {len(names)} files, {vendor.path.name} records {vendor.files}")
    if tree_digest(destination, names) != vendor.tree_sha256:
        raise VendorError("vendor_tree", f"the tree extracted from {vendor.archive.name} does not match {vendor.path.name}")
    return len(names)


def read_member(vendor: Vendor, name: str) -> bytes:
    with tarfile.open(vendor.archive, "r:gz") as archive:
        handle = archive.extractfile(name)
        if handle is None:
            raise VendorError("vendor_member", f"{name!r} is not a file in {vendor.archive.name}")
        return handle.read()


def _entries(node_modules: Path) -> list[tuple[str, Path]]:
    """The tree to pack: every regular file and directory except pnpm's residue and `.bin`."""
    entries: list[tuple[str, Path]] = []
    for parent, names, files in os.walk(node_modules, followlinks=False):
        root = Path(parent)
        if root == node_modules:
            names[:] = [name for name in names if not name.startswith(".")]
            files = [name for name in files if not name.startswith(".")]
        for name in list(names) + list(files):
            path = root / name
            relative = path.relative_to(node_modules).as_posix()
            if path.is_symlink():
                raise VendorError("vendor_symlink", f"{relative} is a link; the archive holds none")
            entries.append((relative, path))
    return sorted(entries)


def build(node_modules: Path, out: Path, vendor_id: str, *, lock: Path, pnpm: str, host: Mapping[str, str | None] | None = None) -> Vendor:
    """Pack one installed hoisted tree as a deterministic archive and write its record beside it."""
    installed = node_modules / "vitest" / "package.json"
    if not installed.is_file():
        raise VendorError("vendor_source", f"{node_modules} holds no vitest; install the fixture first")
    facts = host_facts() if host is None else host
    if not facts.get("node_abi"):
        raise VendorError("vendor_source", "no node on PATH to record the ABI from")
    entries = _entries(node_modules)
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for relative, path in entries:
                info = tarfile.TarInfo(relative)
                info.mtime = MTIME
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    archive.addfile(info)
                    continue
                status = path.stat()
                info.type = tarfile.REGTYPE
                info.size = status.st_size
                info.mode = 0o755 if status.st_mode & 0o100 else 0o644
                with path.open("rb") as handle:
                    archive.addfile(info, handle)
    names = [relative for relative, path in entries if path.is_file()]
    out.mkdir(parents=True, exist_ok=True)
    archive_path = out / f"{vendor_id}{SUFFIX}"
    archive_path.write_bytes(buffer.getvalue())
    record = {
        "id": vendor_id,
        "archive": archive_path.name,
        "archive_sha256": "sha256:" + sha256_file(archive_path),
        "tree_sha256": tree_digest(node_modules, names),
        "files": len(names),
        "platform": facts["platform"],
        "node_abi": facts["node_abi"],
        "vitest": json.loads(installed.read_text(encoding="utf-8"))["version"],
        "lock_sha256": "sha256:" + sha256_file(lock),
        "pnpm": pnpm,
    }
    record_path(out.parent, vendor_id).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return resolve(out.parent, vendor_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m evals.benchmark.vendor")
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("build", help="pack a fixture's installed node_modules as the vendored archive")
    pack.add_argument("--fixture", required=True, type=Path, help="a fixture whose node_modules pnpm has just installed")
    pack.add_argument("--id", required=True, help="the archive id, such as vitest-3.2.4-node24-darwin-arm64")
    pack.add_argument("--pnpm", required=True, help="the pnpm version that produced the tree")
    check = commands.add_parser("check", help="verify an archive against its record and this host")
    check.add_argument("--base", required=True, type=Path, help="the fixtures directory holding vendor/")
    check.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            fixture = args.fixture.resolve()
            vendor = build(fixture / TARGET, fixture.parent / DIR, args.id, lock=fixture / "pnpm-lock.yaml", pnpm=args.pnpm)
        else:
            vendor = resolve(args.base.resolve(), args.id)
            check_archive(vendor)
    except VendorError as error:
        sys.stderr.write(f"{error}\n")
        return 2
    host = host_facts()
    payload = {**vendor.facts, "tree_sha256": vendor.tree_sha256, "archive": str(vendor.archive), "host": host, "host_matches": matches(vendor, host)}
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
