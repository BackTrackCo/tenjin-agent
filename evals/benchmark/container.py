"""One attempt inside its fixture image, run by Harbor's Docker environment.

The trial's roots are built on the host and bind-mounted into the container at
the SAME absolute paths, because the product hashes the working directory into
its local records, the hook template resolves `{data_dir}` to an absolute path,
and the host reads the transcripts back afterwards. The agent and the CLI come
from the image by exact version; the daemon, shim and reporter bundles come from
the seeded data dir, which is a mount, because those are the product build under
test.

Harbor (`harbor==0.22.0`, `evals/benchmark/requirements-live.txt`) owns the
container. It writes the compose project, brings the service up, execs into it,
and tears it down. `EnvironmentConfig.mounts` reaches `services.main.volumes`
verbatim, so a bind at an identical absolute path inside and out survives; the
compose `command` is `sleep infinity`, so the image's ENTRYPOINT still owns the
daemon. Egress is per trial: a `NetworkPolicy` in allowlist mode puts the
service behind a sidecar whose nftables ruleset drops every host off the list.

Everything below is a fact about Harbor that the trial cannot be measured
without: `require_egress` for a kernel probe Harbor fails silently,
`write_environment_override` for an `env` field that is not only the
container's, `remove_project` for objects a failed `up` leaves behind, and
`attestation` for the denial Harbor never reports. `README.md` carries the
evidence for each.

`record_project` is this package's own: one line per attempt naming its compose
project, because after a SIGKILL nothing else on disk says which project to
remove and a prefix sweep cannot tell this run's objects from another run's.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import secrets
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from . import images
from .images import Completed, Docker, ImageError, run_docker

TRIAL_PREFIX = "bench2-"
MOUNT_MARKER = ".bench2-mount"
MOUNT_TIMEOUT_S = 60.0
OUTPUT_VAR = "BENCH2_OUTPUT"
# A docker object name: what `--name` accepts, and what a trial id already is.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
# Harbor names the compose project after the session id and the container
# `<project>-main-1`; the service is always `main` (`harbor/constants.py`).
MAIN_SERVICE = "main"
COMPOSE_PROJECT_LABEL = "com.docker.compose.project"
# Our own compose override, written beside the environment definition.
ENV_OVERRIDE = "bench2-environment.json"
# Harbor's own four bind mounts land under this prefix, and ours are appended
# after them, so a trial root here would collide silently.
RESERVED_MOUNT_ROOT = "/logs"


class EgressError(RuntimeError):
    """Harbor cannot enforce this run's allowlist on this host."""


@dataclass(frozen=True)
class Api:
    """The Harbor symbols this module uses, resolved together."""

    DockerEnvironment: Any
    EnvironmentConfig: Any
    NetworkMode: Any
    NetworkPolicy: Any
    TrialPaths: Any
    version: str


def harbor() -> Api:
    """Import Harbor at the call, never at module scope.

    Harbor is 89 wheels on a 3.12 floor and the required CI job installs twelve
    on 3.11, so a module-scope import would put it in that job's closure for a
    lane that starts no container. `tests/test_container.py` pins it.
    """
    try:
        from importlib.metadata import version

        from harbor.environments.docker.docker import DockerEnvironment
        from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
        from harbor.models.trial.paths import TrialPaths
    except ImportError as error:
        raise ImageError(
            "harbor_missing",
            "no `harbor` importable; a live trial runs inside a Harbor container. "
            "Install it with `pip install -r evals/benchmark/requirements-live.txt`",
        ) from error
    return Api(
        DockerEnvironment=DockerEnvironment,
        EnvironmentConfig=EnvironmentConfig,
        NetworkMode=NetworkMode,
        NetworkPolicy=NetworkPolicy,
        TrialPaths=TrialPaths,
        version=version("harbor"),
    )


@dataclass(frozen=True)
class Mount:
    host: Path
    target: Path
    mode: str = "rw"

    @property
    def volume(self) -> dict[str, Any]:
        """One `services.main.volumes` entry. Harbor writes `source` verbatim, so the path matches inside and out."""
        entry: dict[str, Any] = {"type": "bind", "source": os.path.abspath(self.host), "target": os.path.abspath(self.target)}
        if self.mode == "ro":
            entry["read_only"] = True
        return entry

    def to_json(self) -> dict[str, str]:
        return {"host": str(self.host), "target": str(self.target), "mode": self.mode}


def _name(value: str) -> str:
    if not NAME.match(value):
        raise ImageError("container_name", f"{value!r} is not a usable docker object name")
    return value


def user() -> str:
    """The host's uid and gid: a bind mount the container writes stays the host's file."""
    return f"{os.getuid()}:{os.getgid()}"


def container_name(trial_id: str, phase: str | None = None) -> str:
    """One environment per attempt, named after it, so the ledger and `docker ps` agree."""
    return _name(f"{TRIAL_PREFIX}{trial_id}" if phase is None else f"{TRIAL_PREFIX}{trial_id}-{phase}")


def compose_project(name: str) -> str:
    """The compose project Harbor derives from a session id, which every object of it is labelled with.

    Mirrored from `_sanitize_docker_compose_project_name` rather than called,
    because a dry run builds a `Recipe` with no Harbor importable. The session id
    is the container name and nothing more: copying the `__env` suffix Harbor's
    own `Trial` uses made every cleanup sweep match a project that does not exist.
    """
    sanitised = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    return sanitised if sanitised[:1].isalnum() else f"0{sanitised}"


def mounts(roots: Any, settings: Path | None = None) -> list[Mount]:
    """The trial's own roots at their own paths, plus the output root the entrypoint writes to.

    The design names four: the repository copy, HOME, the profile
    (`CLAUDE_CONFIG_DIR`) and `TENJIN_DATA_DIR`. The output root and the arm's
    settings file are the two more the process cannot run without.
    """
    plan = [
        Mount(roots.repo, roots.repo),
        Mount(roots.home, roots.home),
        Mount(roots.profile, roots.profile),
        Mount(roots.data_dir, roots.data_dir),
        Mount(roots.output, roots.output),
    ]
    if settings is not None:
        plan.append(Mount(settings, settings, "ro"))
    for mount in plan:
        target = os.path.abspath(mount.target)
        if target == RESERVED_MOUNT_ROOT or target.startswith(RESERVED_MOUNT_ROOT + "/"):
            raise ImageError("mount_reserved", f"{target} is under {RESERVED_MOUNT_ROOT}, which Harbor's own mounts own")
    return plan


ALLOWLIST = "allowlist"
NO_NETWORK = "no-network"


@dataclass(frozen=True)
class Egress:
    """What a container may reach: `allowlist` needs hosts and the sidecar, `no-network` needs neither and is what a seed probe runs under."""

    allowlist: tuple[str, ...] = ()
    mode: str = ALLOWLIST

    def to_json(self) -> dict[str, Any]:
        return {"enforced_by": "harbor", "mode": self.mode, "allowlist": sorted(self.allowlist)}


def plan_egress(allowlist: tuple[str, ...], mode: str = ALLOWLIST) -> Egress:
    """The hosts, normalised. Starts nothing, so a dry run can print it."""
    return Egress(allowlist=tuple(sorted({host.strip().lower() for host in allowlist if host and host.strip()})), mode=mode)


def no_network() -> Egress:
    """An egress that reaches nothing at all."""
    return Egress(allowlist=(), mode=NO_NETWORK)


def kernel_supports_egress() -> bool:
    """Harbor's own nftables probe, asked directly. One container, no state."""
    return bool(harbor().DockerEnvironment._egress_control_kernel_support())


def require_egress(egress: Egress, probe: Any = None) -> None:
    """Refuse a run whose allowlist Harbor would silently not enforce.

    `DockerEnvironment.__init__` sets `_enable_egress_control` to the policy AND
    a kernel probe for `CONFIG_NFT_FIB_INET`; a probe that fails leaves the flag
    False with no error and the container on PUBLIC egress. Harbor's own
    `validate_network_policy_support` does not cover it, so an allowlist that is
    never installed would be a different run rather than a weaker one, and it
    ends here instead of in the numbers. `no-network` asks the kernel nothing.
    """
    if egress.mode == NO_NETWORK:
        return
    if not egress.allowlist:
        raise EgressError("an egress with no allowlist would refuse everything, including the provider")
    supported = kernel_supports_egress if probe is None else probe
    if not supported():
        raise EgressError(
            "this Docker host's kernel has no nftables `fib inet` support, so Harbor would drop the allowlist "
            "and run the trial on public egress without saying so"
        )


@dataclass(frozen=True)
class Recipe:
    """Everything one attempt's container is, decided before anything starts.

    A dry run prints this and starts nothing, which is why the image is a name
    here rather than a resolved id and why no Harbor symbol appears: building a
    recipe never imports Harbor and never needs Docker.
    """

    name: str
    image: str
    workdir: Path
    trial_dir: Path
    # The directory Harbor treats as the environment definition. With a
    # prebuilt image nothing in it is read, but Harbor resolves it to an
    # absolute path for `--project-directory`, so it has to exist.
    environment_dir: Path
    plan: list[Mount]
    environment: dict[str, str]
    egress: Egress
    daemon: bool = False
    # The variables the credential travels in, read out of this process at exec
    # time, which is the last moment it exists in this package.
    forward: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {
            "container": self.name,
            "project": compose_project(self.name),
            "image": self.image,
            "workdir": str(self.workdir),
            "mounts": [mount.to_json() for mount in self.plan],
            "env": dict(self.environment),
            "forward": list(self.forward),
            "daemon": self.daemon,
            "egress": self.egress.to_json(),
        }


class Container:
    """One Harbor Docker environment, for the life of one attempt.

    Harbor's API is asyncio and this package's runner is not, so one loop lives
    and dies with the container rather than one per call: `start`, every `exec`
    and `stop` share an environment object and a loop. The container's own
    environment is set at `up` and not at exec, because the ENTRYPOINT starts the
    trial's daemon before any agent runs.
    """

    def __init__(self, *, recipe: Recipe, image: str | None = None, user_id: str | None = None) -> None:
        self.recipe = recipe
        self.name = _name(recipe.name)
        self.project = compose_project(self.name)
        self.environment_dir = recipe.environment_dir
        self.image = recipe.image if image is None else image
        self.user_id = user() if user_id is None else user_id
        self._loop: asyncio.AbstractEventLoop | None = None
        self._environment: Any = None

    def __enter__(self) -> "Container":
        api = harbor()
        require_egress(self.recipe.egress)
        self.recipe.trial_dir.mkdir(parents=True, exist_ok=True)
        self.environment_dir.mkdir(parents=True, exist_ok=True)
        paths = api.TrialPaths(trial_dir=self.recipe.trial_dir)
        paths.mkdir()
        override = write_environment_override(self.environment_dir / ENV_OVERRIDE, self.recipe.environment)
        self._loop = asyncio.new_event_loop()
        try:
            self._environment = api.DockerEnvironment(
                environment_dir=self.environment_dir,
                environment_name=self.name,
                session_id=self.name,
                trial_paths=paths,
                task_env_config=api.EnvironmentConfig(docker_image=self.image),
                network_policy=self._policy(api),
                mounts=[mount.volume for mount in self.recipe.plan],
                extra_docker_compose=[override],
            )
            self._loop.run_until_complete(self._environment.start(force_build=False))
        except BaseException:
            self.close()
            raise
        return self

    def _policy(self, api: Api) -> Any:
        if self.recipe.egress.mode == NO_NETWORK:
            return api.NetworkPolicy(network_mode=api.NetworkMode.NO_NETWORK)
        return api.NetworkPolicy(network_mode=api.NetworkMode.ALLOWLIST, allowed_hosts=sorted(self.recipe.egress.allowlist))

    def __exit__(self, *_: Any) -> None:
        self.close()

    def close(self) -> None:
        """Tear the compose project down, then the loop. Every path here tolerates a thing that is already gone.

        `docker compose down` removes what compose wrote; a project that failed
        on the way up leaves objects it never learns about, so the label sweep
        runs on every path out.
        """
        if self._environment is not None and self._loop is not None:
            with contextlib.suppress(Exception):
                self._loop.run_until_complete(self._environment.stop(delete=True))
        if self._loop is not None:
            with contextlib.suppress(Exception):
                self._loop.close()
        self._environment = None
        self._loop = None
        remove_project(self.project)

    def exec(
        self,
        command: list[str],
        *,
        cwd: Path | None = None,
        environment: Mapping[str, str] | None = None,
        timeout_s: float | None = None,
        stream: Any = None,
    ) -> Completed:
        """One command in the running container. `stream` is written each output chunk as it arrives."""
        if self._environment is None or self._loop is None:
            raise ImageError("container_stopped", f"{self.name} is not running")
        return self._loop.run_until_complete(self._exec(command, cwd, environment, timeout_s, stream))

    async def _exec(
        self,
        command: list[str],
        cwd: Path | None,
        environment: Mapping[str, str] | None,
        timeout_s: float | None,
        stream: Any,
    ) -> Completed:
        call = dict(
            cwd=None if cwd is None else str(cwd),
            env=dict(environment or {}),
            timeout_sec=None if timeout_s is None else int(timeout_s),
            user=self.user_id,
        )
        if stream is None:
            result = await self._environment.exec(shell_command(command), **call)
        else:

            async def collect(chunk: str, _which: Any) -> None:
                stream.write(chunk)
                stream.flush()

            with self._environment.scoped_output_callback(collect):
                result = await self._environment.exec(shell_command(command), **call)
        return Completed(returncode=result.return_code, stdout=result.stdout or "", stderr=result.stderr or "")


def write_environment_override(path: Path, environment: Mapping[str, str]) -> Path:
    """The trial's environment, as a compose override rather than as `EnvironmentConfig.env`.

    Harbor's `env` field is NOT only the container's: `_compose_env_vars` starts
    from `os.environ` and overlays it, and that dict becomes the environment of
    the host-side `docker compose` process. Measured 2026-09-10: a trial root
    named `HOME` retargeted the docker client, which then lost
    `~/.docker/config.json` and the compose plugin, and `up` died with `unknown
    flag: --project-name`. PATH, TMPDIR and the DOCKER_* family would go the same
    way. So the trial's environment goes into the compose file instead, with `$`
    doubled because compose interpolates its own file.
    """
    payload = {"services": {MAIN_SERVICE: {"environment": {key: str(value).replace("$", "$$") for key, value in sorted(environment.items())}}}}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def shell_command(command: list[str]) -> str:
    """One argv as a shell line. Harbor's exec takes a string, so each element is quoted rather than joined."""
    return " ".join(shlex.quote(str(item)) for item in command)


# The two files `split_streams` redirects into, under a directory the container
# and the host both see.
STREAM_FILES = ("command.stdout", "command.stderr")


def split_streams(command: list[str], directory: Path) -> tuple[list[str], Path, Path]:
    """One argv, rewritten to write each of its streams to its own file, and those two paths.

    Harbor merges them: `_run_docker_compose_command` spawns the compose client
    with `stderr=STDOUT`, so `ExecResult.stderr` is always empty and the order
    of an exec's output is the order the two streams interleaved in. A caller
    that KEYS the output cannot use that, because the product keys `stdout` and
    then `stderr` (`src/hooks/arms/failure.ts`), and vitest prints its failures
    to one and its totals to the other. Redirecting inside the container also
    keeps the host-side compose client's own warnings out of the text.
    """
    out, err = directory / STREAM_FILES[0], directory / STREAM_FILES[1]
    return ["bash", "-c", f"{shell_command(command)} > {shlex.quote(str(out))} 2> {shlex.quote(str(err))}"], out, err


# The entrypoint, by the path the base image installs it at, and the argument
# that ends the daemon it started.
TRIAL_ENTRY = "/usr/local/bin/bench2-trial"
STOP_ARG = "--stop"
DAEMON_VAR = "BENCH2_DAEMON"
DAEMON_REPORT = "daemon.json"
# What the entrypoint exits with when the daemon it was asked for never became
# healthy, kept from the argv-era entrypoint because the record's refusal path
# reads it.
DAEMON_REFUSED = 70
STOP_TIMEOUT_S = 60.0


def forwarded(recipe: Recipe, parent: Mapping[str, str]) -> dict[str, str]:
    """The credential, read out of this process at the last moment. From here on its value is in the host's `ps`; see the module docstring."""
    return {name: parent[name] for name in recipe.forward if parent.get(name)}


def daemon_error(output: Path) -> str | None:
    """What the entrypoint recorded about the daemon it was asked to start, or None when it is healthy."""
    try:
        report = json.loads((output / DAEMON_REPORT).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return f"the entrypoint wrote no readable {DAEMON_REPORT}"
    if not isinstance(report, dict) or not report.get("requested"):
        return None
    return None if report.get("started") else str(report.get("error") or "the daemon did not start")


# One line per live attempt, holding the compose project and nothing else.
# After a SIGKILL nothing else on disk says which project to remove, and a
# prefix sweep cannot tell this run's objects from a concurrent run's.
PROJECTS = "projects"


def record_project(run_dir: Path, trial_id: str, name: str) -> str:
    """Name the attempt's compose project on disk, before Harbor creates it."""
    project = compose_project(name)
    directory = run_dir / PROJECTS
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{_name(trial_id)}.project").write_text(project + "\n", encoding="utf-8")
    return project


def forget_project(run_dir: Path, trial_id: str) -> None:
    """The attempt is over and its project is torn down; the line is spent."""
    (run_dir / PROJECTS / f"{_name(trial_id)}.project").unlink(missing_ok=True)


def sweep(run_dir: Path, docker: Docker | None = None) -> dict[str, Any]:
    """Remove every compose project this run recorded and never released. The whole of `cli.py cleanup`.

    A SIGKILLed run leaves the trial container, its egress sidecar, the network
    and an orphaned host-side `docker compose exec` client. Removing the project
    reaches all four: the client is blocked on a container that just went, so it
    exits on its own.
    """
    directory = run_dir / PROJECTS
    removed: dict[str, bool] = {}
    for path in sorted(directory.glob("*.project")) if directory.is_dir() else []:
        try:
            project = path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            # A finishing trial already removed its project and marker.
            continue
        if project:
            removed[project] = remove_project(project, docker)
        path.unlink(missing_ok=True)
    return {"run": str(run_dir), "projects": removed}


def remove_project(project: str, docker: Docker | None = None) -> bool:
    """Remove every container and network compose labelled with this project. True when something went."""
    docker = images._docker(docker)
    label = f"label={COMPOSE_PROJECT_LABEL}={project}"
    removed = False
    for token in _listed(docker, "container", label):
        docker(["rm", "--force", token])
        removed = True
    for token in _listed(docker, "network", label):
        docker(["network", "rm", token])
        removed = True
    return removed


def _listed(docker: Docker, kind: str, label: str) -> list[str]:
    argv = ["ps", "--all", "--quiet", "--filter", label] if kind == "container" else ["network", "ls", "--quiet", "--filter", label]
    try:
        completed = docker(argv)
    except ImageError:
        return []
    return completed.stdout.split() if completed.returncode == 0 else []


def stop(name: str, docker: Docker | None = None) -> bool:
    """Stop and remove one attempt's compose project by container name. True when it was there to stop."""
    try:
        return remove_project(compose_project(name), docker)
    except ImageError:
        return False


def check_mount(run_dir: Path, image: str, docker: Docker | None = None) -> None:
    """Refuse a run directory the container cannot actually see.

    On this machine Docker is a Linux VM that shares only some of the host's
    filesystem, and a run directory outside that set mounts as an empty
    directory: a trial would find no repository. So one container reads one
    marker back before anything is spent, through a plain `docker run` rather
    than a Harbor environment, because the answer is needed before a task, an
    allowlist or a compose project exists.
    """
    docker = images._docker(docker)
    run_dir.mkdir(parents=True, exist_ok=True)
    marker = run_dir / MOUNT_MARKER
    token = secrets.token_hex(8)
    marker.write_text(token, encoding="utf-8")
    path = os.path.abspath(run_dir)
    try:
        completed = docker(
            ["run", "--rm", "--network", "none", "--user", user(), "--volume", f"{path}:{path}:ro", "--entrypoint", "cat", image, f"{path}/{MOUNT_MARKER}"],
            MOUNT_TIMEOUT_S,
        )
    except ImageError as error:
        raise ImageError("mount_invisible", f"{path} could not be mounted into a container: {error.detail}") from error
    finally:
        marker.unlink(missing_ok=True)
    if completed.returncode != 0 or completed.stdout.strip() != token:
        raise ImageError(
            "mount_invisible",
            f"{path} is not visible inside a container, so a trial's roots would be empty; "
            "choose a run directory under a path the Docker VM shares (on colima, your home directory)",
        )


def attestation(egress: Egress, seam: str, instance_id: str) -> dict[str, Any]:
    """The isolation this run established, stated as the attestation's own fields.

    Under Harbor the container, its network and its egress sidecar are per
    attempt, so no run-level object names the isolation: `instance_id` is the
    nonce every compose project of the run derives from, and the per-trial image
    id is in the record. `network_allowlist` is the policy `require_egress`
    proved Harbor would enforce, so it states what the sidecar drops and NOT that
    no attempt tried to leave. Harbor reports no denial, so nothing here can.
    """
    return {
        "kind": "container",
        "instance_id": instance_id,
        "image": f"{images.BASE_IMAGE}@{images.BASE_DIGEST}",
        "fresh_roots": True,
        "wallet_present": False,
        "credential_seam": seam,
        "network_allowlist": sorted(egress.allowlist),
    }


def unavailable(docker: Docker | None = None) -> str | None:
    """Whether a live run can start at all. One sentence, or None."""
    reason = images.unavailable(docker)
    if reason is not None:
        return reason
    if images._docker(docker)(["compose", "version"]).returncode != 0:
        return "`docker compose` is not installed; Harbor's Docker backend shells out to it. Install the compose plugin and try again."
    try:
        harbor()
    except ImageError as error:
        return f"{error.detail}."
    return None


__all__ = [
    "Api",
    "Completed",
    "Container",
    "Egress",
    "EgressError",
    "ImageError",
    "Mount",
    "attestation",
    "check_mount",
    "compose_project",
    "container_name",
    "forget_project",
    "harbor",
    "mounts",
    "plan_egress",
    "record_project",
    "remove_project",
    "require_egress",
    "run_docker",
    "stop",
    "sweep",
    "unavailable",
]
