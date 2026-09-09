"""Fixture images: one pinned base, one image per fixture, built before a live run.

A task fixture is a real Vitest project, and its dependency tree is about 780
files. Committing that tree, or a vendored archive of it, made reproducibility a
property of this repository's bytes on one platform. The image makes it a
property of the build: `node:24-bookworm-slim` by digest, `pnpm` and Claude Code
by exact version, and `pnpm install` run once at build time inside the image, so
a fixture commits a `package.json` and nothing else of the toolchain.

The `tenjin` an agent runs in a Bash tool is THIS CHECKOUT's build, packed and
installed into the base image from `package.json` and every path its `files`
names. A pinned published release cannot redden this lane: it is frozen, so a
CLI change never reaches the measured agent. The version string does not
identify a build either, measured 2026-09-09: `tenjin-cli@0.1.0-alpha.15` on npm
carries no `daemon` command while the repository at that same version string
does. So the recipe hashes the built package by content and the labels carry the
checkout's commit.

`python3 -m evals.benchmark.images build --manifest <path>` builds every image a
manifest names, labels each with the fixture hash, the base image, and the pins
it was built from, and writes the ids to `fixtures/live/images.json`, which is a
local build ledger rather than a committed fact. `live-run` refuses a trial
whose image is missing or whose labels disagree with the manifest, and the
attempt's record carries the image id, the CLI build hash and the CLI commit
under `isolation.image`.

Because the install happens at build time, two builds of one fixture on two
machines may differ in a transitive dependency. That is the trade the design
states: the record names the build that ran, and a locked run builds once and
keeps the image.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import hashlib
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from . import FIXTURES, PACKAGE_ROOT, REPO_ROOT, sha256_file, sha256_json

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
# There is no published-CLI pin. The image installs this checkout's build, so
# the agent's `tenjin` and the daemon under test are one build of the product.
# The egress proxy's image, also by index digest. Nothing is installed into it.
PROXY_IMAGE = "python:3.12-slim"
PROXY_DIGEST = "sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"

BASE_REPOSITORY = "bench2-base"
FIXTURE_PREFIX = "bench2-"
LABEL = "bench2."
TAG_LENGTH = 12
NODE_MODULES = "node_modules"
FIXTURE_PATH = "/opt/fixture"

# The checkout the image's CLI is built from, its package manifest, the entry
# point a build must have produced, and the directory the base build context
# stages the package into.
CLI_ROOT = REPO_ROOT
CLI_MANIFEST = "package.json"
CLI_ENTRY = "dist/index.js"
CLI_STAGE = "cli"
UNKNOWN_COMMIT = "unknown"

BUILD_TIMEOUT_S = 1800.0
DOCKER_TIMEOUT_S = 120.0
EXPORT_TIMEOUT_S = 600.0
GIT_TIMEOUT_S = 30.0


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


def run_git(root: Path, *argv: str) -> str | None:
    """One `git` read in the checkout, or None when there is no answer. The one place this module runs git."""
    try:
        completed = subprocess.run(["git", "-C", str(root), *argv], capture_output=True, text=True, timeout=GIT_TIMEOUT_S, shell=False, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


Git = Callable[..., str | None]


@dataclass(frozen=True)
class CliBuild:
    """The Tenjin CLI the image installs: a built checkout, by content and by commit.

    `hash` is the recipe's identifier, because it is the only one that tracks
    the artefact: it covers `package.json` and every file under the paths its
    `files` names, which is exactly what `npm pack` ships. `commit` is the
    reader's identifier, resolvable back to source, and it is deliberately NOT
    in the recipe: a commit that leaves the built package byte-identical is not
    a new image.
    """

    root: Path
    hash: str
    commit: str
    files: tuple[str, ...]

    @property
    def facts(self) -> dict[str, str]:
        return {"build": self.hash, "commit": self.commit}


def cli_commit(root: Path, git: Git | None = None) -> str:
    """HEAD of the checkout, suffixed `-dirty` when the tree differs from it, `unknown` outside a repository."""
    git = run_git if git is None else git
    head = git(root, "rev-parse", "HEAD")
    if not head:
        return UNKNOWN_COMMIT
    return head if git(root, "status", "--porcelain") == "" else f"{head}-dirty"


def cli_build(root: Path | None = None, git: Git | None = None) -> CliBuild:
    """The package this checkout would publish, hashed by content and named by commit.

    The version string is not an identity: `tenjin-cli@0.1.0-alpha.15` on npm
    carries no `daemon` command while the repository at that same version string
    does, so a lane that installed the release failed with `unknown command
    'daemon'` after its gate had passed. The content hash is what a stale image
    cannot forge.
    """
    root = CLI_ROOT if root is None else root
    manifest = root / CLI_MANIFEST
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ImageError("cli_manifest", f"no readable {CLI_MANIFEST} at {root}; the image installs the CLI this checkout builds") from error
    entries = payload.get("files")
    if not isinstance(entries, list) or not entries:
        raise ImageError("cli_manifest", f"{root / CLI_MANIFEST} names no `files`, so nothing states what the package is")
    if not (root / CLI_ENTRY).is_file():
        raise ImageError(
            "cli_unbuilt",
            f"no {CLI_ENTRY} in {root}; build it with `pnpm build`. The image installs the CLI this checkout builds, not a published release",
        )
    digests = [[CLI_MANIFEST, sha256_file(manifest)]]
    staged = [CLI_MANIFEST]
    for entry in sorted(str(item) for item in entries):
        source = root / entry
        if source.is_dir():
            members = sorted(item for item in source.rglob("*") if item.is_file())
        elif source.is_file():
            members = [source]
        else:
            raise ImageError(
                "cli_files",
                f"{CLI_MANIFEST} `files` names {entry!r}, which is neither a file nor a directory in {root}; "
                "the image stages plain paths, so a pattern there would ship into the image unhashed",
            )
        staged.append(entry)
        digests += [[item.relative_to(root).as_posix(), sha256_file(item)] for item in members]
    return CliBuild(root=root, hash="sha256:" + sha256_json(digests), commit=cli_commit(root, git), files=tuple(staged))


def _cli(cli: CliBuild | None) -> CliBuild:
    """Resolved at the call, never bound as a default, so one build serves a whole `images build`."""
    return cli_build() if cli is None else cli


def recipe(pins: Mapping[str, Any], cli: CliBuild | None = None) -> dict[str, str]:
    """What the base image is built from. The harness version is the manifest's, so a pin change is a rebuild.

    The Dockerfile, the entrypoint and the CLI package are in here by content.
    They are as much the image as any pinned version is, and while the first two
    were not, an edit to either left the tag unchanged and the run silently
    reused a stale image. On 2026-09-09 that hid a fix to the entrypoint through
    two four-attempt runs whose numbers looked plausible. The CLI is now an
    image input for the same reason: a CLI change has to produce a new tag, or
    the lane measures the build before it.
    """
    version = pins.get("harness_version")
    if not isinstance(version, str) or not version.strip():
        raise ImageError("recipe_pins", "pins.harness_version must name the Claude Code version the image installs")
    return {
        "base_image": BASE_IMAGE,
        "base_digest": BASE_DIGEST,
        "pnpm": PNPM_VERSION,
        "claude": version,
        "tenjin_cli": _cli(cli).hash,
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


def fixture_labels(task_id: str, fixture_hash: str, built_from: Mapping[str, str], base_id: str = "", cli_commit: str = "") -> dict[str, str]:
    """The labels a run checks. Every value is a pin or a hash, never a path or a time.

    `cli_commit` is the exception the record needs: a source pointer rather than
    an image input, which is why `UNCOMPARED` keeps it out of the drift check.
    """
    return {
        f"{LABEL}task": task_id,
        f"{LABEL}fixture_hash": fixture_hash,
        f"{LABEL}recipe": recipe_hash(built_from),
        f"{LABEL}base_id": base_id,
        f"{LABEL}cli_commit": cli_commit,
        **{f"{LABEL}{key}": value for key, value in built_from.items()},
    }


# Two labels a run reads but never compares: a rebuilt base is not drift, and
# neither is a new commit whose built package is byte-identical. What identifies
# the CLI build to the drift check is `bench2.tenjin_cli`, its content hash.
UNCOMPARED = (f"{LABEL}base_id", f"{LABEL}cli_commit")


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
        """What reaches the attempt record under `isolation.image`.

        `cli` is here because the version string does not identify a build. The
        content hash is inside `recipe` as well; the commit is the only field a
        reader can resolve back to source.
        """
        return {
            "tag": self.tag,
            "id": self.id,
            "fixture_hash": self.fixture_hash,
            "base_id": self.labels.get(f"{LABEL}base_id", ""),
            "recipe": self.labels.get(f"{LABEL}recipe", ""),
            "cli": {
                "build": self.labels.get(f"{LABEL}tenjin_cli", ""),
                "commit": self.labels.get(f"{LABEL}cli_commit", ""),
            },
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


def require(task: Mapping[str, Any], pins: Mapping[str, Any], docker: Docker | None = None, cli: CliBuild | None = None) -> Image:
    """The image this task's trials run in, or a refusal that names the command that builds it."""
    docker = _docker(docker)
    task_id = str(task["id"])
    fixture_hash = str(task["fixture_hash"])
    tag = fixture_tag(task_id, fixture_hash)
    image = inspect(tag, docker)
    if image is None:
        raise ImageError("image_missing", f"no image {tag} for task {task_id!r}; build it with `python3 -m evals.benchmark.images build --manifest <manifest>`")
    expected = {key: value for key, value in fixture_labels(task_id, fixture_hash, recipe(pins, cli)).items() if key not in UNCOMPARED}
    drifted = sorted(key for key, value in expected.items() if image.labels.get(key) != value)
    if drifted:
        raise ImageError(
            "image_drift",
            f"image {tag} was built from {', '.join(f'{key}={image.labels.get(key)!r}' for key in drifted)}, "
            f"and the manifest states {', '.join(f'{key}={expected[key]!r}' for key in drifted)}; rebuild it with `images build`",
        )
    return image


def stage_cli(cli: CliBuild, destination: Path) -> Path:
    """Copy the package the image installs into a build context: `package.json` and every path its `files` names."""
    destination.mkdir(parents=True, exist_ok=True)
    for entry in cli.files:
        source = cli.root / entry
        target = destination / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, symlinks=False, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
    return destination


def build_base(built_from: Mapping[str, str], docker: Docker | None = None, stream: Any = None, cli: CliBuild | None = None) -> Image:
    """Build the base from a staged context: the entrypoint and this checkout's CLI package, and nothing else of the tree."""
    docker = _docker(docker)
    cli = _cli(cli)
    tag = base_tag(built_from)
    with tempfile.TemporaryDirectory(prefix="bench2-base-") as name:
        context = Path(name)
        shutil.copy2(TRIAL_SCRIPT, context / TRIAL_SCRIPT.name)
        stage_cli(cli, context / CLI_STAGE)
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
            str(context),
        ]
        completed = docker(argv, BUILD_TIMEOUT_S, stream)
    if completed.returncode != 0:
        raise ImageError("base_build_failed", f"`docker build` of {tag} exited {completed.returncode}: {completed.stderr.strip()[-400:]}")
    image = inspect(tag, docker)
    if image is None:
        raise ImageError("base_build_failed", f"{tag} is not present after its build")
    return image


def build_fixture(
    task: Mapping[str, Any],
    fixture: Path,
    built_from: Mapping[str, str],
    base: Image,
    docker: Docker | None = None,
    stream: Any = None,
    cli: CliBuild | None = None,
) -> Image:
    docker = _docker(docker)
    task_id = str(task["id"])
    tag = fixture_tag(task_id, str(task["fixture_hash"]))
    labels = fixture_labels(task_id, str(task["fixture_hash"]), built_from, base.id, _cli(cli).commit)
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


def ledger_write(images: Mapping[str, Image], built_from: Mapping[str, str], path: Path = LEDGER, cli: CliBuild | None = None) -> dict[str, Any]:
    """The local build ledger: which image id each tag names, and what it was built from. Not committed; `images build` rewrites it."""
    payload = {
        "recipe": dict(built_from),
        "recipe_hash": recipe_hash(built_from),
        "cli": None if cli is None else cli.facts,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "images": {tag: image.facts for tag, image in sorted(images.items())},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def build_all(manifest: Any, docker: Docker | None = None, stream: Any = None, only: str | None = None) -> dict[str, Any]:
    """Build the base and every image the manifest's tasks name, then write the ledger.

    The CLI is resolved once here, so every image in one build names the same
    package and the same commit.
    """
    docker = _docker(docker)
    cli = cli_build()
    built_from = recipe(manifest.pins, cli)
    base = build_base(built_from, docker, stream, cli)
    images = {base.tag: base}
    for task in manifest.tasks:
        if only is not None and str(task["id"]) != only:
            continue
        image = build_fixture(task, manifest.fixture_path(task), built_from, base, docker, stream, cli)
        images[image.tag] = image
    return ledger_write(images, built_from, LEDGER, cli)


def check_all(manifest: Any, docker: Docker | None = None) -> dict[str, Any]:
    """Every task's image, or the first refusal. What `live-run` does before it spends anything."""
    docker = _docker(docker)
    cli = cli_build()
    return {str(task["id"]): require(task, manifest.pins, docker, cli).facts for task in manifest.tasks}


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
