"""Resolve a release once; a lock is a portable manifest accepted by every runner command."""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from . import REPO_ROOT, manifest as manifests, sha256_json

SCHEMA = "bench1.harness-lock.v1"
PACKAGES = {"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex"}
REGISTRY = "https://registry.npmjs.org"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
INTEGRITY = re.compile(r"sha512-[A-Za-z0-9+/]{86}==")


def fail(message):
    raise manifests.ManifestError("harness release: " + message)


def metadata(package, requested):
    """npm owns registry transport; no wallet, provider or private registry credentials."""
    with tempfile.TemporaryDirectory(prefix="bench-release-") as home:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "NPM_CONFIG_CACHE": home + "/cache",
               "NPM_CONFIG_USERCONFIG": home + "/user.npmrc", "NPM_CONFIG_GLOBALCONFIG": home + "/global.npmrc"}
        try:
            result = subprocess.run(["npm", "view", f"{package}@{requested}", "version", "dist.integrity", "--json",
                                     "--registry=" + REGISTRY, "--@openai:registry=" + REGISTRY, "--@anthropic-ai:registry=" + REGISTRY],
                                    capture_output=True, text=True, timeout=45, env=env, cwd=home)
            if result.returncode or len(result.stdout) > 4096:
                fail("npm metadata unavailable; no old-version fallback: " + result.stderr.strip()[-2000:])
            return json.loads(result.stdout)
        except manifests.ManifestError:
            raise
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            fail(f"metadata lookup failed ({type(error).__name__}); no old-version fallback")


def read(path):
    if path.is_symlink() or path.stat().st_size > 16384:
        fail("lock must be a bounded regular file")
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        fail("lock must be an object")
    return data


def load_lock(data, path):
    if set(data) != {"schema", "source", "source_hash", "release"} or data["schema"] != SCHEMA:
        fail("unknown lock fields")
    name = data["source"]
    if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:
        fail("source must be a repository-relative manifest")
    source_path = (REPO_ROOT / name).resolve()
    if not source_path.is_relative_to(REPO_ROOT.resolve()):
        fail("source escapes repository")
    if json.loads(source_path.read_text()).get("schema") == SCHEMA:
        fail("nested harness locks are forbidden")
    source = manifests.load(source_path)
    if data["source_hash"] != source.hash:
        fail("source manifest changed; start a new run")
    release = data["release"]
    fields = {"package", "version", "integrity", "requested", "resolved_at", "registry"}
    if not isinstance(release, dict) or set(release) != fields or any(not isinstance(value, str) for value in release.values()):
        fail("malformed release receipt")
    if (release["package"] != PACKAGES.get(source.harness) or release["registry"] != REGISTRY
            or not VERSION.fullmatch(release["version"]) or not INTEGRITY.fullmatch(release["integrity"])
            or (release["requested"] != "latest" and release["requested"] != release["version"])):
        fail("unsupported package, release version or integrity")
    try:
        if datetime.fromisoformat(release["resolved_at"]).utcoffset() is None:
            fail("resolution timestamp needs a timezone")
    except ValueError:
        fail("invalid resolution timestamp")
    if source.pins.get("agent_package", PACKAGES.get(source.harness)) != release["package"]:
        fail("agent package differs from harness")
    resolved = {**source.data, "pins": {**source.pins, "harness_version": release["version"], "harness_integrity": release["integrity"]}}
    manifests.validate(resolved, source.path.parent)
    return replace(source, data=resolved, path=path.resolve(), hash=sha256_json(resolved),
                   fixture_base=source.path.parent, release=release)


def resolve(source_path, out, *, version="latest", from_lock=None, fetch=metadata):
    if version != "latest" and not VERSION.fullmatch(version):
        fail("request latest or an exact release version; prereleases and ranges are excluded")
    source = manifests.load(source_path)
    if source.release is not None:
        fail("resolve the source manifest, or pass an existing lock directly to runner commands")
    package = PACKAGES.get(source.harness)
    if package is None or source.pins.get("agent_package", package) != package:
        fail("only the official Claude/Codex packages are supported")
    try:
        source_name = source.path.relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        fail("source must belong to this checkout")
    if out.exists() or from_lock is not None:
        data = read(out if out.exists() else from_lock)
        locked = load_lock(data, out)
        if data["source"] != source_name or data["source_hash"] != source.hash:
            fail("lock belongs to another experiment")
        if from_lock is None and locked.release["requested"] != version:
            fail("existing lock uses another requested version")
    else:
        info = fetch(package, version)
        if not isinstance(info, dict):
            fail("metadata must describe one release")
        data = {"schema": SCHEMA, "source": source_name, "source_hash": source.hash,
                "release": {"package": package, "version": info.get("version"), "integrity": info.get("dist.integrity"),
                            "requested": version, "registry": REGISTRY,
                            "resolved_at": datetime.now(timezone.utc).isoformat()}}
        load_lock(data, out)
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("x") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", default="latest", help="latest by default; exact release for reproduction")
    parser.add_argument("--from-lock", type=Path, help="restore a checkpoint lock without registry access")
    args = parser.parse_args(argv)
    try:
        result = resolve(args.manifest, args.out, version=args.version, from_lock=args.from_lock)
    except (OSError, ValueError) as error:
        print(f"release resolution refused: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result["release"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
