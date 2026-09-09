"""Fixture images: one pinned base, one image per fixture, built before a live run.

A task fixture is a real Vitest project, and its dependency tree is about 780
files. Committing that tree, or a vendored archive of it, made reproducibility a
property of this repository's bytes on one platform. The image makes it a
property of the build: `node:24-bookworm-slim` by digest, `pnpm`, Claude Code,
and the Tenjin CLI by exact version, and `pnpm install` run once at build time
inside the image, so a fixture commits a `package.json` and nothing else of the
toolchain.

`python3 -m evals.benchmark.images build --manifest <path>` builds every image a
manifest names, labels each with the fixture hash, the base image, and the pins
it was built from, and writes the ids to `fixtures/live/images.json`, which is a
local build ledger rather than a committed fact. `live-run` refuses a trial
whose image is missing or whose labels disagree with the manifest, and the
attempt's record carries the image id under `isolation.image`.

Because the install happens at build time, two builds of one fixture on two
machines may differ in a transitive dependency. That is the trade the design
states: the record names the build that ran, and a locked run builds once and
keeps the image.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import hashlib
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from . import FIXTURES, PACKAGE_ROOT, sha256_json

DOCKER = "docker"
DOCKER_DIR = PACKAGE_ROOT / "docker"
BASE_DOCKERFILE = DOCKER_DIR / "base.Dockerfile"
FIXTURE_DOCKERFILE = DOCKER_DIR / "fixture.Dockerfile"
PROXY_SCRIPT = DOCKER_DIR / "proxy.py"
TRIAL_SCRIPT = DOCKER_DIR / "trial.mjs"
LEDGER = FIXTURES / "live" / "images.json"

# The base, by digest. This is the multi-architecture index digest, so the same
# pin resolves on the operator's arm64 machine and on an amd64 CI runner.
BASE_IMAGE = "node:24-bookworm-slim"
BASE_DIGEST = "sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
PNPM_VERSION = "11.11.0"
# The published CLI whose bundles a provisioned arm seeds. The daemon, shim and
# reporter still come from the operator's own data dir, because they are the
# product build under test; this is the `tenjin` an agent runs in a Bash tool.
TENJIN_VERSION = "0.1.0-alpha.15"
# The egress proxy's image, also by index digest. Nothing is installed into it.
PROXY_IMAGE = "python:3.12-slim"
PROXY_DIGEST = "sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"

BASE_REPOSITORY = "bench2-base"
FIXTURE_PREFIX = "bench2-"
LABEL = "bench2."
TAG_LENGTH = 12
NODE_MODULES = "node_modules"
FIXTURE_PATH = "/opt/fixture"

BUILD_TIMEOUT_S = 1800.0
DOCKER_TIMEOUT_S = 120.0
EXPORT_TIMEOUT_S = 600.0


class ImageError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Completed:
    returncode: int
    stdout: str
    stderr: str


def run_docker(argv: list[str], timeout_s: float = DOCKER_TIMEOUT_S, stream: Any = None) -> Completed:
    """The one place this module runs `docker`. No shell, code-owned argv."""
    try:
        if stream is not None:
            process = subprocess.run([DOCKER, *argv], stdout=stream, stderr=subprocess.STDOUT, timeout=timeout_s, shell=False, check=False)
            return Completed(returncode=process.returncode, stdout="", stderr="")
        completed = subprocess.run([DOCKER, *argv], capture_output=True, text=True, timeout=timeout_s, shell=False, check=False)
    except FileNotFoundError as error:
        raise ImageError("docker_missing", "no `docker` on PATH; a live trial runs inside a container") from error
    except subprocess.TimeoutExpired as error:
        raise ImageError("docker_timeout", f"`docker {argv[0]}` did not finish within {timeout_s:.0f}s") from error
    except OSError as error:
        raise ImageError("docker_failed", f"`docker {argv[0]}` could not run: {error.__class__.__name__}") from error
    return Completed(returncode=completed.returncode, stdout=completed.stdout or "", stderr=completed.stderr or "")


Docker = Callable[..., Completed]


def _docker(docker: Docker | None) -> Docker:
    """Resolved at the call, never bound as a default: an offline case replaces `run_docker` and every path here follows."""
    return run_docker if docker is None else docker


def unavailable(docker: Docker | None = None) -> str | None:
    """One sentence when the daemon cannot be reached, or None. Nothing offline calls this."""
    docker = _docker(docker)
    try:
        completed = docker(["info", "--format", "{{.ServerVersion}}"], DOCKER_TIMEOUT_S)
    except ImageError as error:
        return f"{error.detail}. Start Docker (this machine runs colima) and try again."
    if completed.returncode != 0:
        return "the Docker daemon is not reachable; a live trial runs inside a container. Start Docker (this machine runs colima) and try again."
    return None


def file_hash(path: Path) -> str:
    """One file's content, for the recipe."""
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def recipe(pins: Mapping[str, Any]) -> dict[str, str]:
    """What the base image is built from. The harness version is the manifest's, so a pin change is a rebuild.

    The Dockerfile and the entrypoint are in here by content. They are as much
    the image as any pinned version is, and while they were not, an edit to
    either left the tag unchanged and the run silently reused a stale image. On
    2026-09-09 that hid a fix to the entrypoint through two four-attempt runs
    whose numbers looked plausible.
    """
    version = pins.get("harness_version")
    if not isinstance(version, str) or not version.strip():
        raise ImageError("recipe_pins", "pins.harness_version must name the Claude Code version the image installs")
    return {
        "base_image": BASE_IMAGE,
        "base_digest": BASE_DIGEST,
        "pnpm": PNPM_VERSION,
        "claude": version,
        "tenjin": TENJIN_VERSION,
        "dockerfile": file_hash(BASE_DOCKERFILE),
        "entrypoint": file_hash(TRIAL_SCRIPT),
    }


def recipe_hash(built_from: Mapping[str, str]) -> str:
    return "sha256:" + sha256_json(dict(built_from))


def base_tag(built_from: Mapping[str, str]) -> str:
    """The base tag carries the recipe hash, so a changed pin can never reuse a stale base."""
    return f"{BASE_REPOSITORY}:{recipe_hash(built_from)[len('sha256:'):][:TAG_LENGTH]}"


def fixture_tag(task_id: str, fixture_hash: str) -> str:
    """`bench2-<task>:<fixture hash prefix>`: a fixture edit is a new tag, and the old image is never mistaken for it."""
    if not str(fixture_hash).startswith("sha256:"):
        raise ImageError("fixture_hash", f"task {task_id!r} fixture_hash must be a sha256 token")
    return f"{FIXTURE_PREFIX}{task_id}:{fixture_hash[len('sha256:'):][:TAG_LENGTH]}"


def fixture_labels(task_id: str, fixture_hash: str, built_from: Mapping[str, str], base_id: str) -> dict[str, str]:
    """The labels a run checks. Every value is a pin or a hash, never a path or a time."""
    return {
        f"{LABEL}task": task_id,
        f"{LABEL}fixture_hash": fixture_hash,
        f"{LABEL}recipe": recipe_hash(built_from),
        f"{LABEL}base_id": base_id,
        **{f"{LABEL}{key}": value for key, value in built_from.items()},
    }


@dataclass(frozen=True)
class Image:
    tag: str
    id: str
    labels: dict[str, str]

    @property
    def fixture_hash(self) -> str:
        return self.labels.get(f"{LABEL}fixture_hash", "")

    @property
    def facts(self) -> dict[str, Any]:
        return {
            "tag": self.tag,
            "id": self.id,
            "fixture_hash": self.fixture_hash,
            "base_id": self.labels.get(f"{LABEL}base_id", ""),
            "recipe": self.labels.get(f"{LABEL}recipe", ""),
        }


def inspect(tag: str, docker: Docker | None = None) -> Image | None:
    """The local image behind a tag, or None when there is none."""
    docker = _docker(docker)
    completed = docker(["image", "inspect", tag, "--format", "{{json .}}"], DOCKER_TIMEOUT_S)
    if completed.returncode != 0:
        return None
    try:
        payload = json.loads(completed.stdout.strip() or "{}")
    except json.JSONDecodeError as error:
        raise ImageError("inspect_unreadable", f"`docker image inspect {tag}` did not return JSON") from error
    labels = (payload.get("Config") or {}).get("Labels") or {}
    return Image(tag=tag, id=str(payload.get("Id", "")), labels={str(key): str(value) for key, value in labels.items()})


def require(task: Mapping[str, Any], pins: Mapping[str, Any], docker: Docker | None = None) -> Image:
    """The image this task's trials run in, or a refusal that names the command that builds it."""
    docker = _docker(docker)
    task_id = str(task["id"])
    fixture_hash = str(task["fixture_hash"])
    tag = fixture_tag(task_id, fixture_hash)
    image = inspect(tag, docker)
    if image is None:
        raise ImageError("image_missing", f"no image {tag} for task {task_id!r}; build it with `python3 -m evals.benchmark.images build --manifest <manifest>`")
    expected = {key: value for key, value in fixture_labels(task_id, fixture_hash, recipe(pins), "").items() if not key.endswith("base_id")}
    drifted = sorted(key for key, value in expected.items() if image.labels.get(key) != value)
    if drifted:
        raise ImageError(
            "image_drift",
            f"image {tag} was built from {', '.join(f'{key}={image.labels.get(key)!r}' for key in drifted)}, "
            f"and the manifest states {', '.join(f'{key}={expected[key]!r}' for key in drifted)}; rebuild it with `images build`",
        )
    return image


def build_base(built_from: Mapping[str, str], docker: Docker | None = None, stream: Any = None) -> Image:
    docker = _docker(docker)
    tag = base_tag(built_from)
    argv = [
        "build",
        "--file",
        str(BASE_DOCKERFILE),
        "--tag",
        tag,
        "--build-arg",
        f"BASE_IMAGE={built_from['base_image']}",
        "--build-arg",
        f"BASE_DIGEST={built_from['base_digest']}",
        "--build-arg",
        f"PNPM_VERSION={built_from['pnpm']}",
        "--build-arg",
        f"CLAUDE_VERSION={built_from['claude']}",
        "--build-arg",
        f"TENJIN_VERSION={built_from['tenjin']}",
        str(DOCKER_DIR),
    ]
    completed = docker(argv, BUILD_TIMEOUT_S, stream)
    if completed.returncode != 0:
        raise ImageError("base_build_failed", f"`docker build` of {tag} exited {completed.returncode}: {completed.stderr.strip()[-400:]}")
    image = inspect(tag, docker)
    if image is None:
        raise ImageError("base_build_failed", f"{tag} is not present after its build")
    return image


def build_fixture(
    task: Mapping[str, Any], fixture: Path, built_from: Mapping[str, str], base: Image, docker: Docker | None = None, stream: Any = None
) -> Image:
    docker = _docker(docker)
    task_id = str(task["id"])
    tag = fixture_tag(task_id, str(task["fixture_hash"]))
    labels = fixture_labels(task_id, str(task["fixture_hash"]), built_from, base.id)
    argv = ["build", "--file", str(FIXTURE_DOCKERFILE), "--tag", tag, "--build-arg", f"BASE_TAG={base.tag}"]
    for key, value in sorted(labels.items()):
        argv += ["--label", f"{key}={value}"]
    argv.append(str(fixture))
    completed = docker(argv, BUILD_TIMEOUT_S, stream)
    if completed.returncode != 0:
        raise ImageError("fixture_build_failed", f"`docker build` of {tag} exited {completed.returncode}: {completed.stderr.strip()[-400:]}")
    image = inspect(tag, docker)
    if image is None:
        raise ImageError("fixture_build_failed", f"{tag} is not present after its build")
    return image


def export_node_modules(image: Image, destination: Path, docker: Docker | None = None) -> int:
    """Copy the image's installed tree into the trial's repository copy. The container it needs is removed on every path."""
    docker = _docker(docker)
    destination.mkdir(parents=True, exist_ok=True)
    created = docker(["create", image.tag, "/bin/true"], DOCKER_TIMEOUT_S)
    if created.returncode != 0:
        raise ImageError("export_failed", f"`docker create {image.tag}` exited {created.returncode}: {created.stderr.strip()[-200:]}")
    container = created.stdout.strip().splitlines()[-1].strip()
    try:
        copied = docker(["cp", f"{container}:{FIXTURE_PATH}/{NODE_MODULES}/.", str(destination)], EXPORT_TIMEOUT_S)
        if copied.returncode != 0:
            raise ImageError("export_failed", f"`docker cp` out of {image.tag} exited {copied.returncode}: {copied.stderr.strip()[-200:]}")
    finally:
        docker(["rm", "--force", container], DOCKER_TIMEOUT_S)
    return sum(1 for path in destination.rglob("*") if path.is_file())


def ledger_read(path: Path = LEDGER) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def ledger_write(images: Mapping[str, Image], built_from: Mapping[str, str], path: Path = LEDGER) -> dict[str, Any]:
    """The local build ledger: which image id each tag names, and what it was built from. Not committed; `images build` rewrites it."""
    payload = {
        "recipe": dict(built_from),
        "recipe_hash": recipe_hash(built_from),
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "images": {tag: image.facts for tag, image in sorted(images.items())},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def build_all(manifest: Any, docker: Docker | None = None, stream: Any = None, only: str | None = None) -> dict[str, Any]:
    """Build the base and every image the manifest's tasks name, then write the ledger."""
    docker = _docker(docker)
    built_from = recipe(manifest.pins)
    base = build_base(built_from, docker, stream)
    images = {base.tag: base}
    for task in manifest.tasks:
        if only is not None and str(task["id"]) != only:
            continue
        image = build_fixture(task, manifest.fixture_path(task), built_from, base, docker, stream)
        images[image.tag] = image
    return ledger_write(images, built_from)


def check_all(manifest: Any, docker: Docker | None = None) -> dict[str, Any]:
    """Every task's image, or the first refusal. What `live-run` does before it spends anything."""
    docker = _docker(docker)
    return {str(task["id"]): require(task, manifest.pins, docker).facts for task in manifest.tasks}


def main(argv: list[str] | None = None) -> int:
    from .manifest import ManifestError, load

    parser = argparse.ArgumentParser(prog="python3 -m evals.benchmark.images")
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="build the base image and every image the manifest names")
    build.add_argument("--manifest", required=True, type=Path)
    build.add_argument("--task", help="build one task's image instead of all of them")
    check = commands.add_parser("check", help="verify every image the manifest names is built and current")
    check.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args(argv)
    reason = unavailable()
    if reason is not None:
        sys.stderr.write(reason + "\n")
        return 2
    try:
        manifest = load(args.manifest)
        payload = build_all(manifest, stream=sys.stderr, only=args.task) if args.command == "build" else check_all(manifest)
    except (ImageError, ManifestError) as error:
        sys.stderr.write(f"{error}\n")
        return 2
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
