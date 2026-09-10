"""The container seam: same-path mounts, the docker argv, the run's egress, and the proxy log as the sentinel."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from evals.benchmark import artifact, container, images, reap
from evals.benchmark.images import Completed, ImageError
from evals.benchmark.tests.test_images import FakeDocker

ALLOW = ("api.anthropic.com", "team.example")


@pytest.fixture
def roots(tmp_path: Path) -> artifact.TrialRoots:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "TASK.md").write_text("task\n", encoding="utf-8")
    return artifact.create(tmp_path / "run", "trial-a", fixture)


def test_every_root_is_mounted_at_its_own_absolute_path(roots: artifact.TrialRoots) -> None:
    settings = roots.base / "settings.json"
    settings.write_text("{}\n", encoding="utf-8")
    plan = container.mounts(roots, settings=settings)
    for mount in plan:
        assert str(mount.host) == str(mount.target)
        assert Path(mount.host).is_absolute()
    assert [mount.mode for mount in plan] == ["rw"] * 5 + ["ro"]
    assert plan[0].flag == f"{roots.repo}:{roots.repo}:rw"


def test_the_verifier_copy_is_not_mounted(roots: artifact.TrialRoots) -> None:
    targets = {str(mount.target) for mount in container.mounts(roots)}
    assert str(roots.verify) not in targets


def build_argv(**overrides: Any) -> list[str]:
    base: dict[str, Any] = {
        "image": "sha256:feed",
        "name": "bench2-trial-a",
        "workdir": Path("/runs/trial-a/repo"),
        "plan": [container.Mount(Path("/runs/trial-a/repo"), Path("/runs/trial-a/repo"))],
        "environment": {"HOME": "/runs/trial-a/home"},
        "command": ["claude", "-p", "fix it"],
    }
    return container.run_argv(**{**base, **overrides})


def test_the_credential_crosses_by_name_and_never_as_a_value() -> None:
    argv = build_argv(forward=("CLAUDE_CODE_OAUTH_TOKEN",))
    assert "--env" in argv
    assert "CLAUDE_CODE_OAUTH_TOKEN" in argv
    assert "CLAUDE_CODE_OAUTH_TOKEN=" not in " ".join(argv)
    assert "HOME=/runs/trial-a/home" in argv


def test_the_entrypoint_is_asked_for_a_daemon_only_when_the_arm_has_one() -> None:
    assert container.agent_argv(build_argv(daemon=True)) == ["claude", "-p", "fix it"]
    with_daemon = build_argv(daemon=True)
    assert with_daemon[with_daemon.index("--") - 1] == "--daemon"
    assert "--daemon" not in build_argv()


def test_the_container_joins_only_the_network_it_is_given() -> None:
    argv = build_argv(network="bench2-net-run")
    assert argv[argv.index("--network") + 1] == "bench2-net-run"
    assert "--network" not in build_argv()


@pytest.mark.parametrize("bad", ["../escape", "trial a", "-flag", ""])
def test_a_name_that_is_not_a_docker_object_name_is_refused(bad: str) -> None:
    with pytest.raises(ImageError):
        build_argv(name=bad)


def test_the_container_runs_as_the_host_uid_so_a_mount_stays_the_hosts_file() -> None:
    argv = build_argv()
    assert argv[argv.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"


@pytest.fixture
def run(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def egress(run: Path) -> container.Egress:
    return container.plan_egress(run, ALLOW, "20260908T000000Z-0badf00d")


def test_the_plan_names_an_internal_network_a_proxy_and_a_sorted_allowlist(run: Path, egress: container.Egress) -> None:
    assert egress.network.startswith("bench2-net-")
    assert egress.proxy.startswith("bench2-proxy-")
    assert egress.allowlist == ALLOW
    assert egress.log.parent == run / "proxy"


def test_a_trial_is_told_to_use_the_proxy_for_everything_but_loopback(egress: container.Egress) -> None:
    variables = egress.variables()
    assert variables["HTTPS_PROXY"] == egress.proxy_url
    assert variables["http_proxy"] == egress.proxy_url
    assert variables["NO_PROXY"] == "127.0.0.1,localhost"
    assert variables["NODE_USE_ENV_PROXY"] == "1"


def test_starting_the_egress_creates_an_internal_network_and_a_proxy_on_both(egress: container.Egress) -> None:
    docker = FakeDocker()
    container.start_egress(egress, docker)
    assert docker.calls[0][:3] == ["network", "create", "--internal"]
    run = docker.calls[1]
    assert run[:2] == ["run", "--detach"]
    assert f"{images.PROXY_IMAGE}@{images.PROXY_DIGEST}" in run
    assert [run[position + 1] for position, token in enumerate(run) if token == "--allow"] == list(ALLOW)
    # The proxy starts on the default bridge, where it has a route out, and
    # joins the internal network afterwards.
    assert docker.calls[2] == ["network", "connect", egress.network, egress.proxy]


def test_an_empty_allowlist_is_refused_rather_than_started(run: Path) -> None:
    docker = FakeDocker()
    with pytest.raises(ImageError) as caught:
        container.start_egress(container.plan_egress(run, (), "run"), docker)
    assert caught.value.code == "empty_allowlist"
    assert docker.calls == []


def test_a_proxy_that_cannot_join_leaves_no_network_behind(egress: container.Egress) -> None:
    docker = FakeDocker({"network connect": Completed(returncode=1, stdout="", stderr="no")})
    with pytest.raises(ImageError):
        container.start_egress(egress, docker)
    assert ["network", "rm", egress.network] in docker.calls
    assert ["rm", "--force", egress.proxy] in docker.calls


def test_stopping_removes_the_proxy_and_the_network(egress: container.Egress) -> None:
    docker = FakeDocker()
    report = container.stop_egress(egress, docker)
    assert report == {"proxy": True, "network_removed": True}
    assert docker.calls[0][:2] == ["stop", "--time"]


def test_the_run_waits_for_the_proxy_to_accept_connections(tmp_path: Path) -> None:
    egress = container.plan_egress(tmp_path, ALLOW, "run")
    # A trial that starts first would send its CONNECT into a container
    # with no listener, and a dropped packet on an internal network stalls.
    answers = [Completed(returncode=1, stdout="", stderr=""), Completed(returncode=0, stdout="", stderr="")]
    calls: list[list[str]] = []

    def exec_docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        calls.append(argv)
        return answers[min(len(calls) - 1, len(answers) - 1)]

    container.wait_listening(egress, exec_docker, sleep=lambda seconds: None)
    assert len(calls) == 2
    assert calls[0][:2] == ["exec", egress.proxy]


def test_a_proxy_that_never_listens_is_stopped_and_refused(tmp_path: Path) -> None:
    egress = container.plan_egress(tmp_path, ALLOW, "run")

    def never(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        return Completed(returncode=1, stdout="", stderr="") if argv[0] == "exec" else Completed(returncode=0, stdout="", stderr="")

    with pytest.raises(ImageError) as caught:
        container.wait_listening(egress, never, deadline_s=0.0, sleep=lambda seconds: None)
    assert caught.value.code == "proxy_failed"


# A run directory the container cannot see would give a trial empty roots.


def test_a_visible_directory_passes_and_leaves_no_marker(tmp_path: Path) -> None:
    run = tmp_path / "run"

    def docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        return Completed(returncode=0, stdout=Path(argv[-1]).read_text(encoding="utf-8"), stderr="")

    container.check_mount(run, "bench2-actor:abc", docker)
    assert list(run.iterdir()) == []


def test_a_directory_the_vm_does_not_share_is_refused_by_name(tmp_path: Path) -> None:
    run = tmp_path / "run"

    def docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        return Completed(returncode=1, stdout="", stderr="No such file or directory")

    with pytest.raises(ImageError) as caught:
        container.check_mount(run, "bench2-actor:abc", docker)
    assert caught.value.code == "mount_invisible"
    assert "home directory" in caught.value.detail


def test_the_run_attests_the_isolation_its_own_egress_established() -> None:
    egress = container.plan_egress(Path("/runs/one"), ALLOW, "run")
    payload = container.attestation(egress, "CLAUDE_CODE_OAUTH_TOKEN")
    attestation = artifact.load_attestation_data(payload)
    artifact.check_attestation(attestation, ("api.anthropic.com",), "CLAUDE_CODE_OAUTH_TOKEN")
    assert attestation.kind == "container"
    assert attestation.instance_id == egress.network
    assert attestation.network_allowlist == ALLOW
    assert not attestation.wallet_present
    assert attestation.fresh_roots


def test_an_attestation_whose_allowlist_misses_the_provider_is_still_refused() -> None:
    egress = container.plan_egress(Path("/runs/one"), ("team.example",), "run")
    attestation = artifact.load_attestation_data(container.attestation(egress, "CLAUDE_CODE_OAUTH_TOKEN"))
    with pytest.raises(artifact.IsolationError) as caught:
        artifact.check_attestation(attestation, ("api.anthropic.com",), "CLAUDE_CODE_OAUTH_TOKEN")
    assert caught.value.code == "allowlist_gap"


def write_log(log: Path, *rows: dict[str, Any]) -> None:
    log.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def test_only_a_refused_request_counts_as_a_public_request(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    sentinel = container.ProxySentinel(log, "http://bench2-proxy:8888")
    assert sentinel.hits == []
    write_log(
        log,
        {"host": "api.anthropic.com", "verdict": "allowed"},
        {"host": "example.com", "verdict": "refused", "reason": "not on the allowlist"},
        {"host": "team.example", "verdict": "allowed"},
    )
    assert len(sentinel.entries) == 3
    assert [hit["host"] for hit in sentinel.hits] == ["example.com"]


def test_a_half_written_line_is_skipped_rather_than_raised(tmp_path: Path) -> None:
    log = tmp_path / "requests.jsonl"
    log.write_text('{"verdict": "refused"}\n{"verdict": "ref', encoding="utf-8")
    assert len(container.ProxySentinel(log, "x").hits) == 1


# The ledger reaches a container: killing the client's group does not stop one.


def test_a_container_record_is_stopped_and_the_network_removed(run: Path) -> None:
    reap.register_objects(run, "egress", container="bench2-proxy-run", network="bench2-net-run")
    stopped: list[str] = []
    removed: list[str] = []
    report = reap.reap(
        run,
        probe_fn=lambda pid: None,
        stop_fn=lambda name: stopped.append(name) or True,
        network_fn=lambda name: removed.append(name) or True,
    )
    assert stopped == ["bench2-proxy-run"]
    assert removed == ["bench2-net-run"]
    assert report["outcomes"] == {"egress": "stopped"}
    assert reap.read_records(run) == []


def test_a_trial_record_stops_its_container_as_well_as_its_group(run: Path) -> None:
    record = reap.Record(trial_id="trial-a", pid=4242, pgid=4242, started="Mon", argv0="docker", container="bench2-trial-a")
    reap.write(run, record)
    stopped: list[str] = []
    signalled: list[int] = []
    reap.reap(
        run,
        probe_fn=lambda pid: ("Mon", 4242),
        signal_fn=lambda pgid, sig: signalled.append(pgid),
        sleep=lambda seconds: None,
        stop_fn=lambda name: stopped.append(name) or True,
    )
    assert stopped == ["bench2-trial-a"]
    assert signalled == [4242, 4242]


def test_a_container_only_record_is_never_counted_as_a_live_process(run: Path) -> None:
    reap.register_objects(run, "egress", container="bench2-proxy-run")
    assert reap.survivors(run, probe_fn=lambda pid: ("Mon", 1)) == []
