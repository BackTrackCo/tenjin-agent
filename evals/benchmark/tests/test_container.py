"""The container seam: same-path mounts, the docker argv, the run's egress, and the proxy log as the sentinel."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

from evals.benchmark import artifact, container, images, reap
from evals.benchmark.images import Completed, ImageError
from evals.benchmark.tests.test_images import FakeDocker

ALLOW = ("api.anthropic.com", "team.example")


class MountTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        fixture = self.dir / "fixture"
        fixture.mkdir()
        (fixture / "TASK.md").write_text("task\n", encoding="utf-8")
        self.roots = artifact.create(self.dir / "run", "trial-a", fixture)

    def test_every_root_is_mounted_at_its_own_absolute_path(self) -> None:
        settings = self.roots.base / "settings.json"
        settings.write_text("{}\n", encoding="utf-8")
        plan = container.mounts(self.roots, settings=settings)
        for mount in plan:
            self.assertEqual(str(mount.host), str(mount.target))
            self.assertTrue(Path(mount.host).is_absolute())
        self.assertEqual([mount.mode for mount in plan], ["rw"] * 5 + ["ro"])
        self.assertEqual(plan[0].flag, f"{self.roots.repo}:{self.roots.repo}:rw")

    def test_the_verifier_copy_is_not_mounted(self) -> None:
        targets = {str(mount.target) for mount in container.mounts(self.roots)}
        self.assertNotIn(str(self.roots.verify), targets)


class ArgvTest(unittest.TestCase):
    def argv(self, **overrides: Any) -> list[str]:
        base: dict[str, Any] = {
            "image": "sha256:feed",
            "name": "bench2-trial-a",
            "workdir": Path("/runs/trial-a/repo"),
            "plan": [container.Mount(Path("/runs/trial-a/repo"), Path("/runs/trial-a/repo"))],
            "environment": {"HOME": "/runs/trial-a/home"},
            "command": ["claude", "-p", "fix it"],
        }
        return container.run_argv(**{**base, **overrides})

    def test_the_credential_crosses_by_name_and_never_as_a_value(self) -> None:
        argv = self.argv(forward=("CLAUDE_CODE_OAUTH_TOKEN",))
        self.assertIn("--env", argv)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN", argv)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN=", " ".join(argv))
        self.assertIn("HOME=/runs/trial-a/home", argv)

    def test_the_entrypoint_is_asked_for_a_daemon_only_when_the_arm_has_one(self) -> None:
        self.assertEqual(container.agent_argv(self.argv(daemon=True)), ["claude", "-p", "fix it"])
        with_daemon = self.argv(daemon=True)
        self.assertEqual(with_daemon[with_daemon.index("--") - 1], "--daemon")
        self.assertNotIn("--daemon", self.argv())

    def test_the_container_joins_only_the_network_it_is_given(self) -> None:
        argv = self.argv(network="bench2-net-run")
        self.assertEqual(argv[argv.index("--network") + 1], "bench2-net-run")
        self.assertNotIn("--network", self.argv())

    def test_a_name_that_is_not_a_docker_object_name_is_refused(self) -> None:
        for bad in ("../escape", "trial a", "-flag", ""):
            with self.subTest(bad), self.assertRaises(ImageError):
                self.argv(name=bad)

    def test_the_container_runs_as_the_host_uid_so_a_mount_stays_the_hosts_file(self) -> None:
        argv = self.argv()
        self.assertEqual(argv[argv.index("--user") + 1], f"{os.getuid()}:{os.getgid()}")


class EgressTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name)
        self.egress = container.plan_egress(self.run, ALLOW, "20260908T000000Z-0badf00d")

    def test_the_plan_names_an_internal_network_a_proxy_and_a_sorted_allowlist(self) -> None:
        self.assertTrue(self.egress.network.startswith("bench2-net-"))
        self.assertTrue(self.egress.proxy.startswith("bench2-proxy-"))
        self.assertEqual(self.egress.allowlist, ALLOW)
        self.assertEqual(self.egress.log.parent, self.run / "proxy")

    def test_a_trial_is_told_to_use_the_proxy_for_everything_but_loopback(self) -> None:
        variables = self.egress.variables()
        self.assertEqual(variables["HTTPS_PROXY"], self.egress.proxy_url)
        self.assertEqual(variables["http_proxy"], self.egress.proxy_url)
        self.assertEqual(variables["NO_PROXY"], "127.0.0.1,localhost")
        self.assertEqual(variables["NODE_USE_ENV_PROXY"], "1")

    def test_starting_the_egress_creates_an_internal_network_and_a_proxy_on_both(self) -> None:
        docker = FakeDocker()
        container.start_egress(self.egress, docker)
        self.assertEqual(docker.calls[0][:3], ["network", "create", "--internal"])
        run = docker.calls[1]
        self.assertEqual(run[:2], ["run", "--detach"])
        self.assertIn(f"{images.PROXY_IMAGE}@{images.PROXY_DIGEST}", run)
        self.assertEqual([run[position + 1] for position, token in enumerate(run) if token == "--allow"], list(ALLOW))
        # The proxy starts on the default bridge, where it has a route out, and
        # joins the internal network afterwards.
        self.assertEqual(docker.calls[2], ["network", "connect", self.egress.network, self.egress.proxy])

    def test_an_empty_allowlist_is_refused_rather_than_started(self) -> None:
        docker = FakeDocker()
        with self.assertRaises(ImageError) as caught:
            container.start_egress(container.plan_egress(self.run, (), "run"), docker)
        self.assertEqual(caught.exception.code, "empty_allowlist")
        self.assertEqual(docker.calls, [])

    def test_a_proxy_that_cannot_join_leaves_no_network_behind(self) -> None:
        docker = FakeDocker({"network connect": Completed(returncode=1, stdout="", stderr="no")})
        with self.assertRaises(ImageError):
            container.start_egress(self.egress, docker)
        self.assertIn(["network", "rm", self.egress.network], docker.calls)
        self.assertIn(["rm", "--force", self.egress.proxy], docker.calls)

    def test_stopping_removes_the_proxy_and_the_network(self) -> None:
        docker = FakeDocker()
        report = container.stop_egress(self.egress, docker)
        self.assertEqual(report, {"proxy": True, "network_removed": True})
        self.assertEqual(docker.calls[0][:2], ["stop", "--time"])


class ReadinessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.egress = container.plan_egress(Path(self.tmp.name), ALLOW, "run")

    def test_the_run_waits_for_the_proxy_to_accept_connections(self) -> None:
        # A trial that starts first would send its CONNECT into a container
        # with no listener, and a dropped packet on an internal network stalls.
        answers = [Completed(returncode=1, stdout="", stderr=""), Completed(returncode=0, stdout="", stderr="")]
        calls: list[list[str]] = []

        def exec_docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
            calls.append(argv)
            return answers[min(len(calls) - 1, len(answers) - 1)]

        container.wait_listening(self.egress, exec_docker, sleep=lambda seconds: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][:2], ["exec", self.egress.proxy])

    def test_a_proxy_that_never_listens_is_stopped_and_refused(self) -> None:
        def never(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
            return Completed(returncode=1, stdout="", stderr="") if argv[0] == "exec" else Completed(returncode=0, stdout="", stderr="")

        with self.assertRaises(ImageError) as caught:
            container.wait_listening(self.egress, never, deadline_s=0.0, sleep=lambda seconds: None)
        self.assertEqual(caught.exception.code, "proxy_failed")


class MountCheckTest(unittest.TestCase):
    """A run directory the container cannot see would give a trial empty roots."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name) / "run"

    def test_a_visible_directory_passes_and_leaves_no_marker(self) -> None:
        def docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
            return Completed(returncode=0, stdout=Path(argv[-1]).read_text(encoding="utf-8"), stderr="")

        container.check_mount(self.run, "bench2-actor:abc", docker)
        self.assertEqual(list(self.run.iterdir()), [])

    def test_a_directory_the_vm_does_not_share_is_refused_by_name(self) -> None:
        def docker(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
            return Completed(returncode=1, stdout="", stderr="No such file or directory")

        with self.assertRaises(ImageError) as caught:
            container.check_mount(self.run, "bench2-actor:abc", docker)
        self.assertEqual(caught.exception.code, "mount_invisible")
        self.assertIn("home directory", caught.exception.detail)


class AttestationTest(unittest.TestCase):
    def test_the_run_attests_the_isolation_its_own_egress_established(self) -> None:
        egress = container.plan_egress(Path("/runs/one"), ALLOW, "run")
        payload = container.attestation(egress, "CLAUDE_CODE_OAUTH_TOKEN")
        attestation = artifact.load_attestation_data(payload)
        artifact.check_attestation(attestation, ("api.anthropic.com",), "CLAUDE_CODE_OAUTH_TOKEN")
        self.assertEqual(attestation.kind, "container")
        self.assertEqual(attestation.instance_id, egress.network)
        self.assertEqual(attestation.network_allowlist, ALLOW)
        self.assertFalse(attestation.wallet_present)
        self.assertTrue(attestation.fresh_roots)

    def test_an_attestation_whose_allowlist_misses_the_provider_is_still_refused(self) -> None:
        egress = container.plan_egress(Path("/runs/one"), ("team.example",), "run")
        attestation = artifact.load_attestation_data(container.attestation(egress, "CLAUDE_CODE_OAUTH_TOKEN"))
        with self.assertRaises(artifact.IsolationError) as caught:
            artifact.check_attestation(attestation, ("api.anthropic.com",), "CLAUDE_CODE_OAUTH_TOKEN")
        self.assertEqual(caught.exception.code, "allowlist_gap")


class ProxySentinelTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "requests.jsonl"

    def write(self, *rows: dict[str, Any]) -> None:
        self.log.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def test_only_a_refused_request_counts_as_a_public_request(self) -> None:
        sentinel = container.ProxySentinel(self.log, "http://bench2-proxy:8888")
        self.assertEqual(sentinel.hits, [])
        self.write(
            {"host": "api.anthropic.com", "verdict": "allowed"},
            {"host": "example.com", "verdict": "refused", "reason": "not on the allowlist"},
            {"host": "team.example", "verdict": "allowed"},
        )
        self.assertEqual(len(sentinel.entries), 3)
        self.assertEqual([hit["host"] for hit in sentinel.hits], ["example.com"])

    def test_a_half_written_line_is_skipped_rather_than_raised(self) -> None:
        self.log.write_text('{"verdict": "refused"}\n{"verdict": "ref', encoding="utf-8")
        self.assertEqual(len(container.ProxySentinel(self.log, "x").hits), 1)


class ReaperTest(unittest.TestCase):
    """The ledger reaches a container: killing the client's group does not stop one."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name)

    def test_a_container_record_is_stopped_and_the_network_removed(self) -> None:
        reap.register_objects(self.run, "egress", container="bench2-proxy-run", network="bench2-net-run")
        stopped: list[str] = []
        removed: list[str] = []
        report = reap.reap(
            self.run,
            probe_fn=lambda pid: None,
            stop_fn=lambda name: stopped.append(name) or True,
            network_fn=lambda name: removed.append(name) or True,
        )
        self.assertEqual(stopped, ["bench2-proxy-run"])
        self.assertEqual(removed, ["bench2-net-run"])
        self.assertEqual(report["outcomes"], {"egress": "stopped"})
        self.assertEqual(reap.read_records(self.run), [])

    def test_a_trial_record_stops_its_container_as_well_as_its_group(self) -> None:
        record = reap.Record(trial_id="trial-a", pid=4242, pgid=4242, started="Mon", argv0="docker", container="bench2-trial-a")
        reap.write(self.run, record)
        stopped: list[str] = []
        signalled: list[int] = []
        reap.reap(
            self.run,
            probe_fn=lambda pid: ("Mon", 4242),
            signal_fn=lambda pgid, sig: signalled.append(pgid),
            sleep=lambda seconds: None,
            stop_fn=lambda name: stopped.append(name) or True,
        )
        self.assertEqual(stopped, ["bench2-trial-a"])
        self.assertEqual(signalled, [4242, 4242])

    def test_a_container_only_record_is_never_counted_as_a_live_process(self) -> None:
        reap.register_objects(self.run, "egress", container="bench2-proxy-run")
        self.assertEqual(reap.survivors(self.run, probe_fn=lambda pid: ("Mon", 1)), [])


if __name__ == "__main__":
    unittest.main()
