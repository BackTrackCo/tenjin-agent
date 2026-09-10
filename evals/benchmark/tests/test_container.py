"""The container seam: same-path mounts, the recipe, and the allowlist Harbor is asked to enforce.

Nothing here starts a container or imports Harbor. That second part is the
point of `test_the_offline_suite_never_imports_harbor`: the required CI job
installs twelve wheels on Python 3.11, Harbor needs 3.12 and 89 more, and the
only thing keeping it out of that closure is that every live entry point
resolves it at the call rather than at import.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from evals.benchmark import container, images
from evals.benchmark.container import ImageError

ALLOW = ("api.anthropic.com", "team.example")
REPO_ROOT = Path(__file__).resolve().parents[3]


class Roots:
    """The five roots `container.mounts` reads, without building any of them."""

    def __init__(self, base: Path) -> None:
        self.repo = base / "repo"
        self.home = base / "home"
        self.profile = base / "profile"
        self.data_dir = base / "data"
        self.output = base / "output"


def recipe(base: Path, **overrides: object) -> container.Recipe:
    fields: dict[str, object] = {
        "name": "bench2-trial-a",
        "image": "bench2-actor--abc123def456",
        "workdir": base / "repo",
        "trial_dir": base / "harbor",
        "environment_dir": base / "harbor" / "environment",
        "plan": container.mounts(Roots(base)),
        "environment": {"HOME": str(base / "home")},
        "egress": container.plan_egress(ALLOW),
    }
    fields.update(overrides)
    return container.Recipe(**fields)  # type: ignore[arg-type]


def fake_docker(**answers: images.Completed):
    def docker(argv: list[str], timeout_s: float = 0.0) -> images.Completed:
        return answers.get(argv[0], images.Completed(returncode=0, stdout="", stderr=""))

    return docker


def test_the_offline_suite_never_imports_harbor() -> None:
    # The assertion to trust more than the requirements comment: a module-scope
    # import anywhere in the offline reach fails here rather than three minutes
    # into a required CI job on a Python this package no longer floors at.
    assert "harbor" not in sys.modules
    argv = [sys.executable, "-c", "import sys; import evals.benchmark.cli; print('harbor' in sys.modules)"]
    completed = subprocess.run(argv, capture_output=True, text=True, cwd=str(REPO_ROOT), check=False)
    assert completed.stdout.strip() == "False", completed.stderr[-400:]


def test_every_root_is_mounted_at_its_own_absolute_path(tmp_path: Path) -> None:
    roots = Roots(tmp_path)
    plan = container.mounts(roots, settings=tmp_path / "settings.json")
    assert [mount.host for mount in plan] == [
        roots.repo,
        roots.home,
        roots.profile,
        roots.data_dir,
        roots.output,
        tmp_path / "settings.json",
    ]
    for mount in plan:
        assert mount.host == mount.target
    assert plan[-1].mode == "ro"


def test_a_mount_is_a_compose_bind_and_read_only_is_stated_only_when_it_is(tmp_path: Path) -> None:
    writable = container.Mount(tmp_path / "repo", tmp_path / "repo").volume
    assert writable == {"type": "bind", "source": str(tmp_path / "repo"), "target": str(tmp_path / "repo")}
    assert container.Mount(tmp_path / "s.json", tmp_path / "s.json", "ro").volume["read_only"] is True


def test_a_root_under_the_log_prefix_harbor_owns_is_refused(tmp_path: Path) -> None:
    # Harbor mounts its own four directories under /logs and appends ours after
    # them, so a collision there would be silent rather than an error.
    roots = Roots(tmp_path)
    roots.output = Path("/logs/agent")
    with pytest.raises(ImageError) as caught:
        container.mounts(roots)
    assert caught.value.code == "mount_reserved"


@pytest.mark.parametrize("trial_id", ["trial a", "../escape", "a/b", "x" * 200])
def test_a_trial_id_that_would_not_be_a_docker_object_name_is_refused(trial_id: str) -> None:
    with pytest.raises(ImageError) as caught:
        container.container_name(trial_id)
    assert caught.value.code == "container_name"


def test_a_phase_is_part_of_the_name_so_the_two_containers_of_one_trial_differ() -> None:
    assert container.container_name("27d0f0fe") == "bench2-27d0f0fe"
    assert container.container_name("27d0f0fe", "producer") == "bench2-27d0f0fe-producer"


def test_the_compose_project_is_the_name_harbor_will_label_every_object_with() -> None:
    # The sweep that cleans up after an interrupt matches on the result, so
    # these agree here or `cleanup` reaches nothing: with an `__env` suffix
    # copied from Harbor's own `Trial`, a killed run left two containers and an
    # orphaned exec client behind while the sweep reported success.
    assert container.compose_project("bench2-trial-a") == "bench2-trial-a"
    assert container.compose_project("BENCH2-Trial.A") == "bench2-trial-a"


def test_the_allowlist_is_sorted_deduplicated_and_lowercased() -> None:
    egress = container.plan_egress(("Team.Example", "api.anthropic.com", "team.example", "  ", ""))
    assert egress.allowlist == ALLOW
    assert egress.mode == container.ALLOWLIST
    assert egress.to_json() == {"enforced_by": "harbor", "mode": "allowlist", "allowlist": list(ALLOW)}


def test_an_empty_allowlist_is_refused_rather_than_started() -> None:
    with pytest.raises(container.EgressError) as caught:
        container.require_egress(container.plan_egress(()), probe=lambda: True)
    assert "refuse everything" in str(caught.value)


def test_a_host_that_cannot_enforce_the_allowlist_is_refused_rather_than_measured() -> None:
    # A failed probe leaves egress control off with no error and the container
    # on public egress. That is a different run, not a weaker one.
    with pytest.raises(container.EgressError) as caught:
        container.require_egress(container.plan_egress(ALLOW), probe=lambda: False)
    assert "public egress" in str(caught.value)


def test_a_probe_needs_no_allowlist_and_no_kernel_support_because_it_reaches_nothing() -> None:
    def refuse() -> bool:
        raise AssertionError("a no-network egress asks the kernel nothing")

    container.require_egress(container.no_network(), probe=refuse)
    assert container.no_network().mode == container.NO_NETWORK


def test_a_recipe_states_the_whole_container_and_carries_no_credential_value(tmp_path: Path) -> None:
    plan = recipe(tmp_path, daemon=True, forward=("CLAUDE_CODE_OAUTH_TOKEN",)).to_json()
    assert plan["container"] == "bench2-trial-a"
    assert plan["project"] == "bench2-trial-a"
    assert plan["daemon"] is True
    # The variable's NAME is a fact about the run; its value is not in here.
    assert plan["forward"] == ["CLAUDE_CODE_OAUTH_TOKEN"]
    assert plan["egress"]["allowlist"] == list(ALLOW)
    assert [mount["mode"] for mount in plan["mounts"]] == ["rw"] * 5


def test_the_credential_is_read_out_of_this_process_and_only_when_it_is_set(tmp_path: Path) -> None:
    plan = recipe(tmp_path, forward=("CLAUDE_CODE_OAUTH_TOKEN",))
    assert container.forwarded(plan, {"CLAUDE_CODE_OAUTH_TOKEN": "sk-value"}) == {"CLAUDE_CODE_OAUTH_TOKEN": "sk-value"}
    assert container.forwarded(plan, {}) == {}
    # Absent from the environment the container comes UP with, so absent from
    # the compose override Harbor writes to disk.
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in plan.environment


def test_an_argv_reaches_harbors_exec_as_a_quoted_line_rather_than_a_join() -> None:
    # Harbor's exec takes a string and wraps it in a shell, so anything a task's
    # prompt could put in an argument is quoted here or it is a command.
    assert container.shell_command(["claude", "-p", "fix it; rm -rf /"]) == "claude -p 'fix it; rm -rf /'"


def test_a_daemon_the_entrypoint_could_not_start_is_read_back_as_a_refusal(tmp_path: Path) -> None:
    report = tmp_path / container.DAEMON_REPORT
    assert container.daemon_error(tmp_path) == "the entrypoint wrote no readable daemon.json"
    report.write_text(json.dumps({"requested": False}), encoding="utf-8")
    assert container.daemon_error(tmp_path) is None
    report.write_text(json.dumps({"requested": True, "started": True, "pid": 8}), encoding="utf-8")
    assert container.daemon_error(tmp_path) is None
    report.write_text(json.dumps({"requested": True, "started": False, "error": "no /health"}), encoding="utf-8")
    assert container.daemon_error(tmp_path) == "no /health"


def test_the_run_attests_the_isolation_its_allowlist_established() -> None:
    attestation = container.attestation(container.plan_egress(ALLOW), "CLAUDE_CODE_OAUTH_TOKEN", "20260910T000000Z-0badf00d")
    assert attestation["kind"] == "container"
    assert attestation["instance_id"] == "20260910T000000Z-0badf00d"
    assert attestation["image"] == f"{images.BASE_IMAGE}@{images.BASE_DIGEST}"
    assert attestation["fresh_roots"] is True
    assert attestation["wallet_present"] is False
    assert attestation["credential_seam"] == "CLAUDE_CODE_OAUTH_TOKEN"
    assert attestation["network_allowlist"] == list(ALLOW)
    # No field claims anything about attempted egress, which Harbor never reports.
    assert set(attestation) == {
        "kind",
        "instance_id",
        "image",
        "fresh_roots",
        "wallet_present",
        "credential_seam",
        "network_allowlist",
    }


def test_the_project_sweep_removes_containers_and_networks_by_the_compose_label() -> None:
    calls: list[list[str]] = []

    def docker(argv: list[str], timeout_s: float = 0.0) -> images.Completed:
        calls.append(argv)
        if argv[:2] == ["ps", "--all"]:
            return images.Completed(returncode=0, stdout="c1\nc2\n", stderr="")
        if argv[:2] == ["network", "ls"]:
            return images.Completed(returncode=0, stdout="n1\n", stderr="")
        return images.Completed(returncode=0, stdout="", stderr="")

    assert container.remove_project("bench2-trial-a__env", docker) is True
    label = "label=com.docker.compose.project=bench2-trial-a__env"
    assert calls[0] == ["ps", "--all", "--quiet", "--filter", label]
    assert ["rm", "--force", "c1"] in calls
    assert ["rm", "--force", "c2"] in calls
    assert ["network", "rm", "n1"] in calls


def test_stopping_an_attempt_that_started_nothing_is_not_an_error() -> None:
    docker = fake_docker(ps=images.Completed(returncode=1, stdout="", stderr="no such object"))
    assert container.stop("bench2-trial-a", docker) is False


def test_the_container_runs_as_the_host_uid_so_a_mount_stays_the_hosts_file() -> None:
    assert container.user() == f"{os.getuid()}:{os.getgid()}"


def test_a_missing_docker_compose_is_named_before_anything_is_spent() -> None:
    def docker(argv: list[str], timeout_s: float = 0.0) -> images.Completed:
        if argv[0] == "info":
            return images.Completed(returncode=0, stdout="29.6.1", stderr="")
        if argv == ["compose", "version"]:
            return images.Completed(returncode=1, stdout="", stderr="unknown command")
        return images.Completed(returncode=0, stdout="", stderr="")

    reason = container.unavailable(docker)
    assert reason is not None and "docker compose" in reason
