"""One attempt inside its fixture image: the mounts, the argv, and the run's egress.

The trial's roots are built on the host exactly as before and bind-mounted into
the container at the SAME absolute paths, because the product hashes the working
directory into its local records, the hook template resolves `{data_dir}` to an
absolute path, and the host reads the transcripts back afterwards. The agent and
the CLI come from the image by exact version; the daemon, shim and reporter
bundles come from the seeded data dir, which is a mount, because those are the
product build under test.

The credential seam is forwarded by name (`docker run -e NAME`), so its value
travels through the docker client's own environment and never appears in an
argv, in a file, or in the image.

Egress is a run-level object: one `--internal` Docker network, which has no
route out and no DNS for outside names, and one proxy container on both that
network and the default bridge holding the run's allowlist. A trial container
joins the internal network only and is given the proxy variables, so everything
it sends is either refused by the proxy or logged as allowed. `ProxySentinel`
reads that log, which is what the runner counts as an attempt's public requests.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from . import images
from .images import Completed, Docker, ImageError, run_docker

NETWORK_PREFIX = "bench2-net-"
PROXY_PREFIX = "bench2-proxy-"
TRIAL_PREFIX = "bench2-"
LABEL = "bench2.run"
PROXY_PORT = 8888
PROXY_TARGET = "/opt/bench2/proxy.py"
PROXY_LOG_DIR = "/var/log/bench2"
PROXY_LOG = "requests.jsonl"
PROXY_DIR = "proxy"
STOP_GRACE_S = 2
OUTPUT_VAR = "BENCH2_OUTPUT"
# Node 24 reads the proxy variables for `fetch` only under this flag, and
# Claude Code, the daemon's shelf legs and the CLI's reads are all `fetch`.
NODE_PROXY_VAR = "NODE_USE_ENV_PROXY"
NO_PROXY_HOSTS = "127.0.0.1,localhost"
# A docker object name: what `--name` accepts, and what a trial id already is.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


@dataclass(frozen=True)
class Mount:
    host: Path
    target: Path
    mode: str = "rw"

    @property
    def flag(self) -> str:
        return f"{os.path.abspath(self.host)}:{os.path.abspath(self.target)}:{self.mode}"

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
    """One container per attempt, named after it, so the ledger and `docker ps` agree."""
    return _name(f"{TRIAL_PREFIX}{trial_id}" if phase is None else f"{TRIAL_PREFIX}{trial_id}-{phase}")


def mounts(roots: Any, settings: Path | None = None) -> list[Mount]:
    """The trial's own roots at their own paths, plus the output root the entrypoint writes to.

    The four the design names are the repository copy, HOME, the profile
    (`CLAUDE_CONFIG_DIR`) and `TENJIN_DATA_DIR`. Two more are here because the
    process needs them: the output root, where the entrypoint leaves the
    daemon's log and report, and the arm's settings file, read-only, because
    `--settings` names a path outside every other root.
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
    return plan


@dataclass(frozen=True)
class Egress:
    """The run's network: an internal network and the proxy that holds its allowlist."""

    network: str
    proxy: str
    allowlist: tuple[str, ...]
    log: Path
    port: int = PROXY_PORT

    @property
    def proxy_url(self) -> str:
        return f"http://{self.proxy}:{self.port}"

    def variables(self) -> dict[str, str]:
        """What a trial container is given so every request it makes goes through the proxy."""
        return {
            "HTTP_PROXY": self.proxy_url,
            "HTTPS_PROXY": self.proxy_url,
            "http_proxy": self.proxy_url,
            "https_proxy": self.proxy_url,
            "NO_PROXY": NO_PROXY_HOSTS,
            "no_proxy": NO_PROXY_HOSTS,
            NODE_PROXY_VAR: "1",
        }

    def to_json(self) -> dict[str, Any]:
        return {
            "network": self.network,
            "proxy": self.proxy,
            "proxy_image": f"{images.PROXY_IMAGE}@{images.PROXY_DIGEST}",
            "allowlist": sorted(self.allowlist),
            "log": str(self.log),
        }


def plan_egress(run_dir: Path, allowlist: tuple[str, ...], run_id: str) -> Egress:
    """The names and paths an egress would use. Starts nothing, so a dry run can print it."""
    return Egress(
        network=_name(f"{NETWORK_PREFIX}{run_id}"),
        proxy=_name(f"{PROXY_PREFIX}{run_id}"),
        allowlist=tuple(sorted({host.strip().lower() for host in allowlist if host and host.strip()})),
        log=run_dir / PROXY_DIR / PROXY_LOG,
    )


def start_egress(egress: Egress, docker: Docker | None = None) -> Egress:
    """Create the internal network and start the proxy on it and on the default bridge."""
    docker = images._docker(docker)
    if not egress.allowlist:
        raise ImageError("empty_allowlist", "an egress with no allowlist would refuse everything, including the provider")
    egress.log.parent.mkdir(parents=True, exist_ok=True)
    created = docker(["network", "create", "--internal", "--label", f"{LABEL}={egress.network}", egress.network])
    if created.returncode != 0:
        raise ImageError("network_failed", f"`docker network create {egress.network}` exited {created.returncode}: {created.stderr.strip()[-200:]}")
    argv = [
        "run",
        "--detach",
        "--name",
        egress.proxy,
        "--label",
        f"{LABEL}={egress.network}",
        "--volume",
        f"{os.path.abspath(images.PROXY_SCRIPT)}:{PROXY_TARGET}:ro",
        "--volume",
        f"{os.path.abspath(egress.log.parent)}:{PROXY_LOG_DIR}:rw",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        f"{images.PROXY_IMAGE}@{images.PROXY_DIGEST}",
        "python3",
        PROXY_TARGET,
        "--port",
        str(egress.port),
        "--log",
        f"{PROXY_LOG_DIR}/{egress.log.name}",
    ]
    for host in egress.allowlist:
        argv += ["--allow", host]
    started = docker(argv)
    if started.returncode != 0:
        docker(["network", "rm", egress.network])
        raise ImageError("proxy_failed", f"`docker run` of {egress.proxy} exited {started.returncode}: {started.stderr.strip()[-200:]}")
    joined = docker(["network", "connect", egress.network, egress.proxy])
    if joined.returncode != 0:
        stop_egress(egress, docker)
        raise ImageError("proxy_failed", f"the proxy could not join {egress.network}: {joined.stderr.strip()[-200:]}")
    return egress


def stop_egress(egress: Egress, docker: Docker | None = None) -> dict[str, Any]:
    """Stop the proxy and remove the network. Every path here tolerates a thing that is already gone."""
    docker = images._docker(docker)
    stopped = stop(egress.proxy, docker)
    removed = docker(["network", "rm", egress.network])
    return {"proxy": stopped, "network_removed": removed.returncode == 0}


def stop(name: str, docker: Docker | None = None) -> bool:
    """Stop and remove one container by name. True when it was there to stop."""
    docker = images._docker(docker)
    try:
        halted = docker(["stop", "--time", str(STOP_GRACE_S), name])
        docker(["rm", "--force", name])
    except ImageError:
        return False
    return halted.returncode == 0


def run_argv(
    *,
    image: str,
    name: str,
    workdir: Path,
    plan: list[Mount],
    environment: Mapping[str, str],
    forward: tuple[str, ...] = (),
    network: str | None = None,
    daemon: bool = False,
    command: list[str],
    user_id: str | None = None,
) -> list[str]:
    """The whole `docker run`. Every value here is code-owned or already checked by the caller.

    `forward` names variables passed without a value: docker reads them from
    this process's environment, which is how the credential seam reaches the
    container and nothing else.
    """
    argv = [
        images.DOCKER,
        "run",
        "--rm",
        "--init",
        "--name",
        _name(name),
        "--workdir",
        str(workdir),
        "--user",
        user_id if user_id is not None else user(),
    ]
    if network is not None:
        argv += ["--network", _name(network)]
    for mount in plan:
        argv += ["--volume", mount.flag]
    for key in sorted(environment):
        argv += ["--env", f"{key}={environment[key]}"]
    for key in forward:
        argv += ["--env", key]
    argv.append(image)
    if daemon:
        argv.append("--daemon")
    return argv + ["--", *command]


def agent_argv(argv: list[str]) -> list[str]:
    """The command the entrypoint runs, out of a full `docker run` argv. What a reader wants to see."""
    return argv[argv.index("--") + 1 :] if "--" in argv else argv


class ProxySentinel:
    """The proxy log as the run's sentinel: every refused request is a public request.

    A container cannot reach a loopback origin on the host, so the planted
    origin the fake path uses has no meaning here. What replaces it is stronger:
    the proxy sees every request that leaves, and a host outside the allowlist
    is refused there rather than counted afterwards.
    """

    def __init__(self, log: Path, origin: str) -> None:
        self.log = log
        self.origin = origin

    @property
    def entries(self) -> list[dict[str, Any]]:
        try:
            text = self.log.read_text(encoding="utf-8")
        except OSError:
            return []
        rows = []
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows

    @property
    def hits(self) -> list[dict[str, Any]]:
        return [row for row in self.entries if row.get("verdict") == "refused"]


def unavailable(docker: Docker | None = None) -> str | None:
    """Whether a live run can start at all. One sentence, or None."""
    return images.unavailable(docker)


__all__ = [
    "Completed",
    "Egress",
    "ImageError",
    "Mount",
    "ProxySentinel",
    "agent_argv",
    "container_name",
    "mounts",
    "plan_egress",
    "run_argv",
    "start_egress",
    "stop",
    "stop_egress",
    "unavailable",
]
