"""Fixture images: one pinned base, one image per fixture, content-addressed by Harbor.

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
does.

Identity is Harbor's (`harbor.environments.docker.utils`). Every image is named
`<stem>--<hash>`, a blake2b over the whole build context, the Dockerfile's
bytes, every build argument and the daemon's platform, built by `docker buildx
build` behind a file lock. That subsumes the recipe this module used to hash by
hand and covers three things it did not: every file of the context rather than a
chosen list, the platform, and the fixture's own tree. The base's name is a build
argument of each fixture, so a base input reaches every fixture name too.

There is no drift check left, because an input that moved cannot name the image
that is here: it is absent, and `require` says which command builds it. Two
properties the old recipe carried are checked elsewhere: a manifest's
`fixture_hash` against the fixture directory by `manifest.py` at load, and a
task's declared runtime quirk by `quirk_check` inside the image the build just
produced.

`python3 -m evals.benchmark.images build --manifest <path>` builds every image a
manifest names and writes them to `fixtures/live/images.json`, a local ledger
rather than a committed fact. `pnpm install` happens at build time, so two builds
of one fixture on two machines may differ in a transitive dependency: the record
names the build that ran, and a locked run builds once and keeps the image.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from . import FIXTURES, PACKAGE_ROOT, REPO_ROOT
from .verifier import HIDDEN

DOCKER = "docker"
DOCKER_DIR = PACKAGE_ROOT / "docker"
BASE_DOCKERFILE = DOCKER_DIR / "base.Dockerfile"
FIXTURE_DOCKERFILE = DOCKER_DIR / "fixture.Dockerfile"
TRIAL_SCRIPT = DOCKER_DIR / "trial.mjs"
LEDGER = FIXTURES / "live" / "images.json"

# The base, by digest. This is the multi-architecture index digest, so the same
# pin resolves on the operator's arm64 machine and on an amd64 CI runner.
BASE_IMAGE = "node:24-bookworm-slim"
BASE_DIGEST = "sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
PNPM_VERSION = "11.11.0"
# There is no published-CLI pin. The image installs this checkout's build, so
# the agent's `tenjin` and the daemon under test are one build of the product.

BASE_STEM = "bench2-base"
FIXTURE_PREFIX = "bench2-"
NODE_MODULES = "node_modules"
FIXTURE_PATH = "/opt/fixture"
# A task whose difficulty rests on a runtime behaviour rather than on its own
# files states that behaviour as a check in its hidden layer, and the build runs
# it inside the image it just built. Without it a base bump that moved the
# behaviour would turn a hard task into a trivial one and the corpus would go on
# reporting the old number. The layer is mounted read-only and the check is
# code-owned, so a fixture cannot supply one.
QUIRK_CHECK = "image-check.mjs"
CHECK_PATH = "/opt/bench2/check"

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


def run_docker(argv: list[str], timeout_s: float = DOCKER_TIMEOUT_S) -> Completed:
    """The one place this module runs `docker`. No shell, code-owned argv."""
    try:
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
    """One sentence when an image cannot be built or read here, or None. Nothing offline calls this."""
    docker = _docker(docker)
    try:
        completed = docker(["info", "--format", "{{.ServerVersion}}"], DOCKER_TIMEOUT_S)
    except ImageError as error:
        return f"{error.detail}. Start Docker (this machine runs colima) and try again."
    if completed.returncode != 0:
        return "the Docker daemon is not reachable; a live trial runs inside a container. Start Docker (this machine runs colima) and try again."
    if docker(["buildx", "version"], DOCKER_TIMEOUT_S).returncode != 0:
        return (
            "`docker buildx` is not installed; Harbor builds every image with BuildKit, this package's and its own "
            "egress sidecar. Install the buildx plugin and try again."
        )
    return None


@dataclass(frozen=True)
class Build:
    """The Harbor symbols this module uses, resolved together."""

    ensure: Any
    context_hash: Any
    name: Any
    platform: Any


def harbor() -> Build:
    """Import Harbor at the call, never at module scope.

    Harbor is 89 wheels on a 3.12 floor and the required CI job installs twelve
    on 3.11, so a module-scope import would put it in that job's closure for a
    lane that builds nothing.
    """
    try:
        from harbor.environments.docker.utils import _compute_image_name, default_docker_platform, ensure_docker_image_built
        from harbor.utils.container_cache import docker_build_context_hash
    except ImportError as error:
        raise ImageError(
            "harbor_missing",
            "no `harbor` importable; it owns this package's image identity and its builds. "
            "Install it with `pip install -r evals/benchmark/requirements-live.txt`",
        ) from error
    return Build(ensure=ensure_docker_image_built, context_hash=docker_build_context_hash, name=_compute_image_name, platform=default_docker_platform)


def run_git(root: Path, *argv: str) -> str | None:
    """One `git` read in the checkout, or None when there is no answer. The one place this module runs git."""
    try:
        completed = subprocess.run(["git", "-C", str(root), *argv], capture_output=True, text=True, timeout=GIT_TIMEOUT_S, shell=False, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


Git = Callable[..., str | None]


def cli_commit(root: Path, git: Git | None = None) -> str:
    """HEAD of the checkout, suffixed `-dirty` when the tree differs from it, `unknown` outside a repository.

    The reader's identifier, resolvable back to source, and deliberately not an
    image input: a commit that leaves the built package byte-identical is not a
    new image, and Harbor's hash agrees because it never sees a commit.
    """
    git = run_git if git is None else git
    head = git(root, "rev-parse", "HEAD")
    if not head:
        return UNKNOWN_COMMIT
    return head if git(root, "status", "--porcelain") == "" else f"{head}-dirty"


def cli_files(root: Path) -> tuple[str, ...]:
    """`package.json` and every path its `files` names, from a checkout that has been built.

    The paths only. What the package IS is Harbor's hash of the staged context,
    so nothing here digests a file; this refuses the two shapes that would stage
    the wrong thing, a glob and an unbuilt tree.
    """
    manifest = root / CLI_MANIFEST
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ImageError("cli_manifest", f"no readable {CLI_MANIFEST} at {root}; the image installs the CLI this checkout builds") from error
    entries = payload.get("files")
    if not isinstance(entries, list) or not entries:
        raise ImageError("cli_manifest", f"{manifest} names no `files`, so nothing states what the package is")
    if not (root / CLI_ENTRY).is_file():
        raise ImageError(
            "cli_unbuilt",
            f"no {CLI_ENTRY} in {root}; build it with `pnpm build`. The image installs the CLI this checkout builds, not a published release",
        )
    for entry in entries:
        if not (root / str(entry)).exists():
            raise ImageError(
                "cli_files",
                f"{CLI_MANIFEST} `files` names {str(entry)!r}, which is neither a file nor a directory in {root}; "
                "the image stages plain paths, so a pattern there would ship into the image unhashed",
            )
    return (CLI_MANIFEST, *sorted(str(entry) for entry in entries))


def stage_cli(root: Path, files: tuple[str, ...], destination: Path) -> Path:
    """Copy the package the image installs into a build context."""
    destination.mkdir(parents=True, exist_ok=True)
    for entry in files:
        source = root / entry
        target = destination / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, symlinks=False, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
    return destination


def build_args(pins: Mapping[str, Any]) -> dict[str, str]:
    """The base's build arguments, which Harbor's hash makes part of its name. The harness version is the manifest's, so a pin change is a rebuild."""
    version = pins.get("harness_version")
    if not isinstance(version, str) or not version.strip():
        raise ImageError("recipe_pins", "pins.harness_version must name the Claude Code version the image installs")
    return {"BASE_IMAGE": BASE_IMAGE, "BASE_DIGEST": BASE_DIGEST, "PNPM_VERSION": PNPM_VERSION, "CLAUDE_VERSION": version}


# The staged contexts of this process, held so their directories outlive the
# call that built them: a context IS the base image's name under Harbor's hash,
# so it is staged once and every trial after the first reads that staging.
_STAGED: list[Any] = []


def stage_base(root: Path, files: tuple[str, ...]) -> Path:
    """The base build context on disk: the entrypoint and the CLI package, and nothing else of the tree."""
    staging = tempfile.TemporaryDirectory(prefix="bench2-base-")
    _STAGED.append(staging)
    context = Path(staging.name)
    shutil.copy2(TRIAL_SCRIPT, context / TRIAL_SCRIPT.name)
    stage_cli(root, files, context / CLI_STAGE)
    return context


@dataclass(frozen=True)
class Plan:
    """Everything every image of one run is built from, resolved once.

    `base` is the name Harbor's hash gives the base context, and it is a build
    argument of each fixture, so a moved pin, Dockerfile or CLI file reaches
    every fixture name too. `cli_build` is that same hash over the staged
    package alone: the record names the build it measured, because a version
    string does not identify one.
    """

    context: Path
    platform: str
    args: dict[str, str]
    base: str
    cli_build: str
    commit: str

    @property
    def cli(self) -> dict[str, str]:
        return {"build": self.cli_build, "commit": self.commit}


def plan(pins: Mapping[str, Any], root: Path | None = None, git: Git | None = None) -> Plan:
    """Stage the base context, ask the daemon its platform, and name what follows from both."""
    root = CLI_ROOT if root is None else root
    build = harbor()
    context = stage_base(root, cli_files(root))
    args = build_args(pins)
    platform = asyncio.run(build.platform())
    key = build.context_hash(context=context, dockerfile_path=BASE_DOCKERFILE, build_args=args, platform=platform)
    return Plan(
        context=context,
        platform=platform,
        args=args,
        base=build.name(BASE_STEM, key),
        cli_build=build.context_hash(context=context / CLI_STAGE),
        commit=cli_commit(root, git),
    )


_PLANS: dict[str, Plan] = {}


def _plan(pins: Mapping[str, Any], resolved: Plan | None = None) -> Plan:
    """Resolved at the call and once per run: staging the CLI copies 15MB, and every trial asks for it."""
    if resolved is not None:
        return resolved
    key = str(pins.get("harness_version"))
    if key not in _PLANS:
        _PLANS[key] = plan(pins)
    return _PLANS[key]


def fixture_stem(task_id: str) -> str:
    """The half of a fixture image's name that is not its content hash: what a dry run can state without a daemon."""
    return f"{FIXTURE_PREFIX}{task_id}"


def fixture_name(task: Mapping[str, Any], fixture: Path, resolved: Plan) -> str:
    """`bench2-<task>--<hash>`: the fixture's own tree, the Dockerfile, the base it sits on, and the platform."""
    build = harbor()
    key = build.context_hash(context=fixture, dockerfile_path=FIXTURE_DOCKERFILE, build_args={"BASE_TAG": resolved.base}, platform=resolved.platform)
    return str(build.name(fixture_stem(str(task["id"])), key))


@dataclass(frozen=True)
class Image:
    """One built image, as the attempt record carries it under `isolation.image`."""

    tag: str
    id: str
    fixture_hash: str = ""
    base: str = ""
    cli: dict[str, str] = field(default_factory=dict)

    @property
    def facts(self) -> dict[str, Any]:
        return {"tag": self.tag, "id": self.id, "fixture_hash": self.fixture_hash, "base": self.base, "cli": dict(self.cli)}


def image_id(name: str, docker: Docker | None = None) -> str | None:
    """The local image behind a name, or None when there is none."""
    completed = _docker(docker)(["image", "inspect", name, "--format", "{{.Id}}"], DOCKER_TIMEOUT_S)
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def require(task: Mapping[str, Any], fixture: Path, pins: Mapping[str, Any], docker: Docker | None = None, resolved: Plan | None = None) -> Image:
    """The image this task's trials run in, or a refusal that names the command that builds it.

    There is no drift check. The name is a content address over the fixture, the
    base it is built on, the Dockerfile and the platform, so an input that moved
    cannot name the image that is here: it is absent. That is the whole of what
    the labels used to check, and one fewer thing to keep true.
    """
    resolved = _plan(pins, resolved)
    name = fixture_name(task, fixture, resolved)
    found = image_id(name, docker)
    if found is None:
        raise ImageError(
            "image_missing",
            f"no image {name} for task {str(task['id'])!r}; build it with `python3 -m evals.benchmark.images build --manifest <manifest>`",
        )
    return Image(tag=name, id=found, fixture_hash=str(task["fixture_hash"]), base=resolved.base, cli=resolved.cli)


def build_image(stem: str, context: Path, dockerfile: Path, args: Mapping[str, str], resolved: Plan) -> str:
    """Build one content-addressed image through Harbor, or refuse with what its build said.

    Harbor names the image after the hash, holds a file lock so two builds of
    one image cannot race, re-checks the daemon after taking it, and writes the
    build log under its own cache directory. A failed build raises with the
    whole of that log, which is why the refusal here truncates.
    """
    build = harbor()
    try:
        return str(
            asyncio.run(
                build.ensure(
                    docker_name=stem,
                    docker_build_context=context,
                    dockerfile_path=dockerfile,
                    build_args=dict(args),
                    platform=resolved.platform,
                    timeout_sec=BUILD_TIMEOUT_S,
                )
            )
        )
    except RuntimeError as error:
        raise ImageError("build_failed", f"{stem}: {str(error)[-600:]}") from error


def quirk_check(task_id: str, name: str, docker: Docker | None = None) -> str | None:
    """Run the task's hidden image check inside its image, or None when it declares none.

    The check reads the task's own frozen cases and asserts the runtime still
    produces them, so its failure names the fact that went rather than a test
    that broke. `--network none`: a check that reached anything would be
    measuring something other than this image.
    """
    layer = HIDDEN / task_id
    if not (layer / QUIRK_CHECK).is_file():
        return None
    completed = _docker(docker)(
        ["run", "--rm", "--network", "none", "--entrypoint", "node", "--volume", f"{layer}:{CHECK_PATH}:ro", name, f"{CHECK_PATH}/{QUIRK_CHECK}"],
        DOCKER_TIMEOUT_S,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[-400:]
        raise ImageError("image_quirk_absent", f"{task_id} declares a runtime quirk this image does not have: {detail}")
    return completed.stdout.strip()[-200:]


def export_node_modules(image: Image, destination: Path, docker: Docker | None = None) -> int:
    """Copy the image's installed tree into the trial's repository copy. The container it needs is removed on every path.

    Staged from the fixture root rather than taken out of `node_modules`
    directly. A workspace fixture's installed tree links out of `node_modules`
    into the package it links (`@fixture/range -> ../../packages/range`), and
    `docker cp` refuses to write a link that leaves the directory being copied:
    measured 2026-09-09 as `invalid symlink`, with the whole export failing.
    Staged from `/opt/fixture` that link resolves inside the copy and is
    written, and moving `node_modules` on alone leaves the trial's own fixture
    files untouched. The staging directory is inside the repository copy, so the
    move is a rename rather than a second traversal of 780 files, and it is gone
    before the trial's roots are handed to anything.
    """
    docker = _docker(docker)
    destination.mkdir(parents=True, exist_ok=True)
    created = docker(["create", image.tag, "/bin/true"], DOCKER_TIMEOUT_S)
    if created.returncode != 0:
        raise ImageError("export_failed", f"`docker create {image.tag}` exited {created.returncode}: {created.stderr.strip()[-200:]}")
    container = created.stdout.strip().splitlines()[-1].strip()
    try:
        with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
            copied = docker(["cp", f"{container}:{FIXTURE_PATH}/.", staging], EXPORT_TIMEOUT_S)
            if copied.returncode != 0:
                raise ImageError("export_failed", f"`docker cp` out of {image.tag} exited {copied.returncode}: {copied.stderr.strip()[-200:]}")
            staged = Path(staging) / NODE_MODULES
            if not staged.is_dir():
                raise ImageError("export_failed", f"{image.tag} carries no {FIXTURE_PATH}/{NODE_MODULES} to export")
            for entry in staged.iterdir():
                shutil.move(str(entry), str(destination / entry.name))
    finally:
        docker(["rm", "--force", container], DOCKER_TIMEOUT_S)
    return sum(1 for path in destination.rglob("*") if path.is_file())


def ledger_read(path: Path = LEDGER) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def ledger_write(built: Mapping[str, Image], resolved: Plan, path: Path = LEDGER) -> dict[str, Any]:
    """The local build ledger: which id each image name has, and what the run was built from. Not committed; `images build` rewrites it."""
    payload = {
        "base": resolved.base,
        "platform": resolved.platform,
        "pins": dict(resolved.args),
        "cli": resolved.cli,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "images": {name: image.facts for name, image in sorted(built.items())},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def _say(log: Any, line: str) -> None:
    """A build runs for minutes and Harbor writes its output to a log of its own, so the caller gets one line per image."""
    if log is not None:
        log.write(line + "\n")
        log.flush()


def build_all(manifest: Any, docker: Docker | None = None, only: str | None = None, log: Any = None, ledger: Path = LEDGER) -> dict[str, Any]:
    """Build the base and every image the manifest's tasks name, then write the ledger."""
    resolved = _plan(manifest.pins)
    _say(log, f"base {resolved.base} ({resolved.platform})")
    base = build_image(BASE_STEM, resolved.context, BASE_DOCKERFILE, resolved.args, resolved)
    if base != resolved.base:
        raise ImageError("base_name", f"Harbor built {base} where this run resolved {resolved.base}, so a trial would look for a name that does not exist")
    built = {base: Image(tag=base, id=image_id(base, docker) or "", base=base, cli=resolved.cli)}
    for task in manifest.tasks:
        task_id = str(task["id"])
        if only is not None and task_id != only:
            continue
        fixture = manifest.fixture_path(task)
        _say(log, f"{task_id} {fixture_name(task, fixture, resolved)}")
        name = build_image(fixture_stem(task_id), fixture, FIXTURE_DOCKERFILE, {"BASE_TAG": base}, resolved)
        quirk_check(task_id, name, docker)
        built[name] = Image(tag=name, id=image_id(name, docker) or "", fixture_hash=str(task["fixture_hash"]), base=base, cli=resolved.cli)
    return ledger_write(built, resolved, ledger)


def check_all(manifest: Any, docker: Docker | None = None) -> dict[str, Any]:
    """Every task's image, or the first refusal. What `live-run` does before it spends anything."""
    resolved = _plan(manifest.pins)
    return {str(task["id"]): require(task, manifest.fixture_path(task), manifest.pins, docker, resolved).facts for task in manifest.tasks}


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
        payload = build_all(manifest, only=args.task, log=sys.stderr) if args.command == "build" else check_all(manifest)
    except (ImageError, ManifestError) as error:
        sys.stderr.write(f"{error}\n")
        return 2
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
