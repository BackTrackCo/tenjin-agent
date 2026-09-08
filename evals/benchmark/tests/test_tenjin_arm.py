"""The Tenjin hooks arm: seeded data dir, one daemon per trial, stopped before the join.

Every daemon here is `tests/fake_daemon.py`, started and stopped inside the
case that needs it. Nothing reads an operator's data dir: the source is a
temp directory with two placeholder bundles and a config written by the case.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from evals.benchmark import artifact, cli, executor, reap, records, runner, schedule, signature, tenjin_arm, vendor
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec, ProvisionError, ProvisionRequest
from evals.benchmark.tests import support

FAKE_DAEMON = [sys.executable, str(Path(__file__).with_name("fake_daemon.py"))]
SECRET = "bench1-test-shelf-secret-0123456789abcdef"
LIVE = "live_provisioned_for_this_test"


def _gone(pid: int, deadline_s: float = 5.0) -> bool:
    import time

    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return True
        time.sleep(0.02)
    return False


class SourceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"

    def write_source(self, config: dict | None = None, bundles: bool = True) -> Path:
        source = self.dir / "source"
        (source / "hooks").mkdir(parents=True, exist_ok=True)
        if bundles:
            for name in tenjin_arm.BUNDLES:
                (source / "hooks" / name).write_text(f"// placeholder {name}\n", encoding="utf-8")
        base = {
            "baseUrl": "https://team-shelf.example",
            "publicShelfUrl": "https://public.example",
            "shelfBypassSecret": SECRET,
            "wallet": {"address": "0xabc"},
            "publish": {"mode": "full-auto"},
            "team": {"publicFallback": "on"},
            "hooks": {"capture": "on"},
        }
        (source / "config.json").write_text(json.dumps(base if config is None else config), encoding="utf-8")
        (source / "wallet.json").write_text('{"private": "never read"}', encoding="utf-8")
        return source

    def roots(self, trial: str = "trial-a") -> artifact.TrialRoots:
        fixture = self.dir / "fixture"
        fixture.mkdir(exist_ok=True)
        (fixture / "TASK.md").write_text("task\n", encoding="utf-8")
        return artifact.create(self.run_dir, trial, fixture)


class SourceTest(SourceCase):
    def test_only_the_copied_keys_are_read_and_the_secret_is_a_fact_not_a_value(self) -> None:
        source = tenjin_arm.load_source(self.write_source())
        self.assertEqual(sorted(source.config), ["baseUrl", "publicShelfUrl", "shelfBypassSecret"])
        self.assertTrue(source.shelf_secret_present)
        self.assertEqual(source.facts, {"shelf_secret_present": True, "shelf_origin": "team-shelf.example", "public_origin": "public.example"})
        self.assertEqual(source.origins, ("team-shelf.example", "public.example"))
        self.assertEqual(source.secrets, (SECRET,))
        self.assertNotIn(SECRET, json.dumps(source.facts))

    def test_a_source_without_a_secret_is_public_mode(self) -> None:
        source = tenjin_arm.load_source(self.write_source({"baseUrl": "https://tenjin.blog"}))
        self.assertFalse(source.shelf_secret_present)
        self.assertEqual(source.secrets, ())
        self.assertEqual(source.facts["shelf_origin"], "tenjin.blog")

    def test_a_source_that_cannot_seed_a_trial_is_refused(self) -> None:
        cases = {
            "no bundles": dict(bundles=False),
            "no baseUrl": dict(config={"shelfBypassSecret": SECRET}),
            "secret that is not a string": dict(config={"baseUrl": "https://x.example", "shelfBypassSecret": 1}),
        }
        for name, edit in cases.items():
            with self.subTest(name), self.assertRaises(ProvisionError):
                tenjin_arm.load_source(self.write_source(**edit))
        with self.assertRaises(ProvisionError):
            tenjin_arm.load_source(self.dir / "absent")

    def test_the_seeded_config_forces_the_constants_and_carries_the_port(self) -> None:
        source = tenjin_arm.load_source(self.write_source())
        seeded = tenjin_arm.seeded_config(source, 4321)
        self.assertEqual(seeded["publish"], {"mode": "review"})
        self.assertEqual(seeded["hooks"], {"capture": "off"})
        self.assertEqual(seeded["team"], {"publicFallback": "on"})
        self.assertEqual(seeded["loop"], {"idle_exit_min": 2, "port": 4321})
        self.assertEqual(seeded["shelfBypassSecret"], SECRET)
        self.assertNotIn("wallet", seeded)
        self.assertNotIn("shelfBypassSecret", tenjin_arm.seeded_config(source, 1, with_secret=False))


class DaemonCase(SourceCase):
    def setUp(self) -> None:
        super().setUp()
        self.patch = mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.source = tenjin_arm.load_source(self.write_source())

    def prepare(self, roots: artifact.TrialRoots, *, dry_run: bool = False) -> executor.Provision:
        request = ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, self.source, dry_run=dry_run)
        provision = tenjin_arm.prepare(request)
        started = provision.stop_state.get("started")
        if started is not None:
            self.addCleanup(lambda: runner.process_stop(started, roots.run_dir, 2.0))
        return provision


class PrepareStopTest(DaemonCase):
    def test_prepare_seeds_the_data_dir_starts_one_daemon_and_stop_ends_it_with_the_wal(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        data = roots.data_dir
        self.assertEqual(sorted(path.name for path in (data / "hooks").iterdir()), sorted(tenjin_arm.BUNDLES))
        token = (data / "daemon.token").read_text(encoding="utf-8")
        self.assertEqual(oct((data / "daemon.token").stat().st_mode & 0o777), "0o600")
        seeded = json.loads((data / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(seeded["shelfBypassSecret"], SECRET)
        self.assertEqual(seeded["team"], {"publicFallback": "on"})
        pid_record = json.loads((data / "daemon.pid").read_text(encoding="utf-8"))
        self.assertEqual(provision.values["daemon_url"], f"http://127.0.0.1:{pid_record['port']}/hook/claude")
        self.assertEqual(provision.values["daemon_token"], token)
        self.assertEqual(provision.values["data_dir"], str(data))
        self.assertEqual(provision.secrets, (SECRET,))
        self.assertEqual(provision.facts["shelf_origin"], "team-shelf.example")
        self.assertTrue((data / "loop.db-wal").exists())
        # The reaper knows the daemon under the trial's own ledger id.
        ledger = [record.trial_id for record in reap.read_records(roots.run_dir)]
        self.assertEqual(ledger, [f"{roots.trial_id}.daemon"])
        # The resolved hook URL and token are what the daemon accepts.
        request = urllib.request.Request(
            provision.values["daemon_url"], data=b"{}", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)
        pid = provision.stop_state["pid"]
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report, {"respawned": False, "wal_live": False})
        self.assertTrue(_gone(pid))
        self.assertFalse((data / "loop.db-wal").exists())
        self.assertEqual(reap.read_records(roots.run_dir), [])

    def test_stop_reaches_a_daemon_the_shim_respawned_through_its_own_pid_record(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        ours = provision.stop_state["pid"]
        # A detached daemon the shim started is outside every group the
        # runner recorded; it announces itself only through daemon.pid.
        env = tenjin_arm.daemon_environment(roots)
        respawned = subprocess.Popen(FAKE_DAEMON + ["--port", "0"], cwd=roots.data_dir, env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: respawned.poll() is None and respawned.kill())
        import time

        end = time.monotonic() + 5
        while time.monotonic() < end and (tenjin_arm.read_pid(roots.data_dir) or {}).get("pid") != respawned.pid:
            time.sleep(0.02)
        self.assertEqual(tenjin_arm.read_pid(roots.data_dir)["pid"], respawned.pid)
        # The respawned daemon is this test's child, so it lingers as a zombie
        # until waited on; the grace wait is shortened for that reason alone.
        with mock.patch.object(tenjin_arm, "STOP_GRACE_S", 0.5):
            report = tenjin_arm.stop(roots, provision)
        self.assertTrue(report["respawned"])
        self.assertIsNotNone(respawned.wait(timeout=5))
        self.assertTrue(_gone(ours))

    def test_a_pid_record_that_does_not_answer_for_this_data_dir_is_left_alone(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        self.addCleanup(stranger.kill)
        # A stale or forged record naming a live process that is not a daemon.
        (roots.data_dir / "daemon.pid").write_text(json.dumps({"pid": stranger.pid, "port": 1, "started_at": 0, "data_dir": str(roots.data_dir)}), encoding="utf-8")
        report = tenjin_arm.stop(roots, provision)
        self.assertFalse(report["respawned"])
        self.assertIsNone(stranger.poll(), "a process that never answered /health for this data dir must not be signalled")

    def test_a_wal_the_daemon_leaves_behind_is_reported_not_hidden(self) -> None:
        roots = self.roots()
        with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON) + ["--keep-wal"]), mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
            provision = self.prepare(roots)
            report = tenjin_arm.stop(roots, provision)
        self.assertTrue(report["wal_live"])

    def test_a_daemon_that_never_answers_is_stopped_and_refused(self) -> None:
        roots = self.roots()
        sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
        with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: sleeper), mock.patch.object(tenjin_arm, "HEALTH_TIMEOUT_S", 0.3):
            with self.assertRaises(ProvisionError) as caught:
                self.prepare(roots)
        self.assertIn("/health", str(caught.exception))
        self.assertEqual(reap.read_records(roots.run_dir), [])

    def test_a_dry_run_seeds_without_a_secret_a_token_or_a_daemon(self) -> None:
        roots = self.roots()
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
            provision = self.prepare(roots, dry_run=True)
        self.assertFalse((roots.data_dir / "daemon.token").exists())
        seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn("shelfBypassSecret", seeded)
        self.assertEqual(provision.values["daemon_url"], "http://127.0.0.1:0/hook/claude")
        self.assertEqual(provision.values["daemon_token"], tenjin_arm.DRY_TOKEN)
        self.assertEqual(provision.stop_state, {})
        self.assertEqual(tenjin_arm.stop(roots, provision), {"respawned": False, "wal_live": False})

    def test_the_daemon_environment_is_the_trials_own(self) -> None:
        roots = self.roots()
        env = tenjin_arm.daemon_environment(roots, {"PATH": "/usr/bin", "LANG": "C", "TENJIN_WALLET_PRIVATE_KEY": "0xdead", "HOME": "/Users/operator"})
        self.assertEqual(sorted(env), ["HOME", "LANG", "PATH", "TENJIN_DATA_DIR"])
        self.assertEqual(env["HOME"], str(roots.home))
        self.assertEqual(env["TENJIN_DATA_DIR"], os.path.abspath(roots.data_dir))


class SentinelTest(SourceCase):
    def test_the_seeded_secret_is_a_canary_everywhere_but_the_seeded_config(self) -> None:
        roots = self.roots()
        (roots.data_dir / "config.json").write_text(json.dumps({"shelfBypassSecret": SECRET}), encoding="utf-8")
        clean = artifact.scan_sentinels(roots, 0, canaries=(SECRET,), exclude=(roots.data_dir / "config.json",))
        self.assertEqual(clean.credential_exposures, 0)
        (roots.repo / "notes.md").write_text(f"header {SECRET}\n", encoding="utf-8")
        transcript = roots.profile / "projects" / "p" / "root.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({"text": SECRET}) + "\n", encoding="utf-8")
        (roots.output / "daemon.log").write_text(f"sent {SECRET}\n", encoding="utf-8")
        report = artifact.scan_sentinels(roots, 0, canaries=(SECRET,), exclude=(roots.data_dir / "config.json",))
        self.assertEqual(report.credential_exposures, 3)
        self.assertEqual(report.reason, "sentinel:credential_exposure")


class RunnerCase(DaemonCase):
    """The runner's provision flow, with the fake executor's launch and the fake daemon."""

    def setUp(self) -> None:
        super().setUp()
        executor.REGISTRY[LIVE] = ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
            prepare=tenjin_arm.prepare,
            stop=tenjin_arm.stop,
        )
        self.addCleanup(executor.REGISTRY.pop, LIVE)

    def manifest(self, **overrides: object) -> object:
        manifest = support.synthetic_manifest(self.dir, executor_name=LIVE, arms=("off", "tenjin_seeded"), **overrides)  # type: ignore[arg-type]
        manifest.data["arms"][1]["provision"] = "tenjin"
        return manifest

    def runtime(self, **overrides: object) -> runner.Runtime:
        clock = support.FakeClock()
        base = {"clock": clock, "sleep": clock.sleep, "spawn": support.fake_spawn(), "settle_cap_s": 1.0, "publishable": False, "ci": False, "source": self.source}
        return runner.Runtime(**{**base, **overrides})  # type: ignore[arg-type]

    def trial(self, manifest: object, arm: str) -> schedule.Trial:
        return next(trial for trial in schedule.expand(manifest) if trial.arm_id == arm)  # type: ignore[arg-type]


class RunnerTest(RunnerCase):
    def test_a_provisioned_trial_runs_between_prepare_and_stop_and_records_the_facts(self) -> None:
        manifest = self.manifest()
        seen: list[tuple[bool, bool]] = []

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            record = tenjin_arm.read_pid(roots.data_dir)
            seen.append((record is not None, (roots.data_dir / "loop.db-wal").exists()))

        runtime = self.runtime(spawn=support.fake_spawn(before=before))
        record = runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", runtime)
        records.validate(record)
        # The daemon was up while the agent ran, and gone with its WAL before the join.
        self.assertEqual(seen, [(True, True)])
        self.assertEqual(record["outcome"], "pass")
        isolation = record["isolation"]
        self.assertEqual((isolation["publishable"], isolation["shelf_secret_present"], isolation["shelf_origin"]), (False, True, "team-shelf.example"))
        self.assertEqual(isolation["daemon_respawned"], False)
        self.assertEqual(record["delivery"]["classes"], {"team": 0, "public": 0, "local": 0, "other": 0})
        self.assertEqual(reap.read_records(self.run_dir), [])
        self.assertNotIn(SECRET, json.dumps(record))

    def test_the_off_arm_is_not_provisioned_and_still_carries_the_facts(self) -> None:
        manifest = self.manifest()
        record = runner.run_trial(manifest, self.trial(manifest, "off"), self.run_dir, "sha256:schedule", self.runtime())
        records.validate(record)
        self.assertFalse((self.run_dir / "trials" / record["trial_id"] / "data" / "config.json").exists())
        self.assertEqual(record["isolation"]["shelf_secret_present"], False)
        self.assertNotIn("daemon_respawned", record["isolation"])

    def test_a_publishable_run_with_a_seeded_secret_is_refused_before_any_root_exists(self) -> None:
        manifest = self.manifest()
        with self.assertRaises(IsolationError) as caught:
            runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(publishable=True, attestation=support.ATTESTED))
        self.assertEqual(caught.exception.code, "shelf_secret_publishable")
        self.assertFalse((self.run_dir / "trials").exists())

    def test_an_attestation_has_to_list_the_seeded_shelf_origin(self) -> None:
        public = tenjin_arm.load_source(self.write_source({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example"}))
        manifest = self.manifest()
        with self.assertRaises(IsolationError) as caught:
            runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(publishable=True, attestation=support.ATTESTED, source=public))
        self.assertEqual(caught.exception.code, "allowlist_gap")
        self.assertIn("team-shelf.example", str(caught.exception))

    def test_a_wal_left_live_makes_the_attempt_invalid(self) -> None:
        manifest = self.manifest()
        with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON) + ["--keep-wal"]), mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
            record = runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime())
        self.assertEqual((record["outcome"], record["invalid_reason"]), ("invalid", "delivery:wal_live"))
        self.assertEqual(reap.read_records(self.run_dir), [])

    def legs(self, *shelves: str | tuple[str, str, str]):
        """Legs on one prompt fire: a shelf name, or (shelf, status, outcome)."""

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            db = roots.data_dir / "loop.db"
            support.write_loop_db(db, [("fire-1", launch.root_session_id, "")])
            import sqlite3

            connection = sqlite3.connect(db)
            for stage, leg in enumerate(shelves, start=1):
                shelf, status, outcome = (leg, "ok", "hit") if isinstance(leg, str) else leg
                connection.execute(
                    "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-1', ?, ?, ?, ?, 5)", (stage, shelf, status, outcome)
                )
            connection.commit()
            connection.close()

        return before

    def test_team_and_public_fallback_legs_are_named_origins_and_an_unknown_shelf_is_a_public_request(self) -> None:
        manifest = self.manifest()
        public = tenjin_arm.load_source(self.write_source({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example"}))
        # A team miss that fell back to the public marketplace: two named legs.
        record = runner.run_trial(
            manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(spawn=support.fake_spawn(before=self.legs("team", "public")), source=public)
        )
        self.assertEqual(record["delivery"]["classes"], {"team": 1, "public": 1, "local": 0, "other": 0})
        self.assertEqual(record["sentinel"]["public_requests"], 0)
        self.assertEqual(record["outcome"], "pass")
        # A leg to a shelf this package cannot name is a request to an unknown origin.
        record = runner.run_trial(
            manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(spawn=support.fake_spawn(before=self.legs("team", "mirror")), source=public)
        )
        self.assertEqual(record["delivery"]["shelves"], {"team": 1, "public": 0, "keys": 0, "local": 0, "other": 1})
        self.assertEqual(record["delivery"]["classes"], {"team": 1, "public": 0, "local": 0, "other": 1})
        self.assertEqual((record["outcome"], record["invalid_reason"]), ("invalid", "sentinel:public_request"))
        self.assertEqual(record["sentinel"]["public_requests"], 1)

    def test_keys_and_local_legs_are_classified_and_never_invalidate(self) -> None:
        # What the second hooks smoke recorded per seeded attempt: the prompt
        # fire's team miss and public timeout, then two tool-failure fires
        # each sending a keys leg and a local leg. Every one of them is inside
        # the seeded config's reachable set, so none is a public request.
        manifest = self.manifest()
        public = tenjin_arm.load_source(self.write_source({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example"}))
        legs = self.legs(
            ("team", "ok", "miss"),
            ("public", "timeout", "no-answer"),
            ("keys", "ok", "miss"),
            ("local", "ok", "miss"),
            ("keys", "ok", "hit"),
            ("local", "ok", "miss"),
        )
        record = runner.run_trial(
            manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(spawn=support.fake_spawn(before=legs), source=public)
        )
        self.assertEqual(record["outcome"], "pass")
        self.assertEqual(record["sentinel"]["public_requests"], 0)
        self.assertEqual(record["delivery"]["shelves"], {"team": 1, "public": 1, "keys": 2, "local": 2, "other": 0})
        self.assertEqual(record["delivery"]["classes"], {"team": 1, "public": 3, "local": 2, "other": 0})
        self.assertEqual(record["delivery"]["public"], {"legs": 3, "hits": 1, "timeouts": 1, "no_answer": 1})
        # The leg's own status and outcome travel with it.
        statuses = [(leg["shelf"], leg["status"], leg["outcome"]) for leg in record["delivery"]["legs"]]
        self.assertIn(("public", "timeout", "no-answer"), statuses)
        # A publishable run has to list both named origins beside the provider.
        listed = support.ATTESTED.__class__(**{**support.ATTESTED.__dict__, "network_allowlist": ("api.provider.example", "team-shelf.example")})
        with self.assertRaises(IsolationError) as caught:
            runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(source=public, publishable=True, attestation=listed))
        self.assertIn("public.example", str(caught.exception))


class CliTest(SourceCase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.write_source()
        self.environ = {"CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token"}

    def test_ci_live_refuses_a_manifest_that_provisions_an_arm(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.HOOKS_SMOKE_MANIFEST, None, plumbing=True, ci_live=True, environ={"CI": "1", **self.environ}, tenjin_source=self.source)
        self.assertIn("--ci-live", str(caught.exception))
        self.assertFalse(self.run_dir.exists())
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.dict(os.environ, {"CI": "1", **self.environ}):
            code = cli.main(["live-run", "--manifest", str(cli.HOOKS_SMOKE_MANIFEST), "--out", str(self.run_dir), "--plumbing", "--ci-live", "--tenjin-source", str(self.source)])
        self.assertEqual(code, 2)
        self.assertIn("smoke-only", stderr.getvalue())

    def test_a_provisioned_manifest_needs_a_source_and_a_secret_source_refuses_an_attestation(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.HOOKS_SMOKE_MANIFEST, None, plumbing=True, environ=self.environ)
        self.assertIn("--tenjin-source", str(caught.exception))
        attestation = self.dir / "attestation.json"
        attestation.write_text("{}", encoding="utf-8")
        with self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.HOOKS_SMOKE_MANIFEST, attestation, environ=self.environ, tenjin_source=self.source)
        self.assertIn("never publishable", str(caught.exception))
        with self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.SMOKE_MANIFEST, None, plumbing=True, environ=self.environ, tenjin_source=self.source)
        self.assertIn("no provisioned arm", str(caught.exception).replace("has none", "no provisioned arm"))

    def test_the_dry_run_resolves_the_hooks_and_prints_no_token_and_no_secret(self) -> None:
        stream = io.StringIO()
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
            payload = cli.live_run(self.run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=stream, environ={}, tenjin_source=self.source)
        printed = stream.getvalue()
        self.assertEqual(len(payload["trials"]), 4)
        seeded = [plan for plan in payload["trials"] if plan["arm_id"] == "tenjin_seeded"]
        self.assertEqual(len(seeded), 2)
        for plan in seeded:
            self.assertEqual(plan["provision"]["shelf_secret_present"], True)
            self.assertEqual(len(plan["hooks"]), 11)
            self.assertTrue(any(hook.startswith("SubagentStart http http://127.0.0.1:0/hook/claude headers=Authorization") for hook in plan["hooks"]))
            self.assertTrue(any("tenjin-shim.mjs" in hook and hook.startswith("SessionStart command") for hook in plan["hooks"]))
        self.assertIn("shelf_secret_present=true shelf_origin=team-shelf.example", printed)
        # The vendored toolchain is named, with the host verdict, and nothing was extracted.
        self.assertIn("vendor    vitest-3.2.4-node24-darwin-arm64 platform=darwin-arm64 node_abi=137 host=", printed)
        self.assertIn(("extracted into repo/node_modules" if vendor.host_platform() == "darwin-arm64" else "MISMATCH"), printed)
        for plan in payload["trials"]:
            self.assertEqual(plan["vendor"]["id"], "vitest-3.2.4-node24-darwin-arm64")
            self.assertFalse((Path(plan["roots"]["cwd"]) / "node_modules" / "vitest").exists())
        self.assertNotIn(SECRET, printed)
        self.assertNotIn(tenjin_arm.DRY_TOKEN, printed)
        for plan in payload["trials"]:
            if plan["arm_id"] == "off":
                self.assertEqual(plan["hooks"], [])
                self.assertIsNone(plan["provision"])

    def test_the_dry_run_needs_no_source(self) -> None:
        stream = io.StringIO()
        payload = cli.live_run(self.run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=stream, environ={})
        seeded = next(plan for plan in payload["trials"] if plan["arm_id"] == "tenjin_seeded")
        self.assertEqual(seeded["provision"]["shelf_secret_present"], False)

    def test_a_report_that_carries_the_seeded_secret_is_deleted(self) -> None:
        self.run_dir.mkdir()
        (self.run_dir / "report.json").write_text(json.dumps({"x": SECRET}), encoding="utf-8")
        with self.assertRaises(cli.CliError):
            cli.refuse_secret_in_report(self.run_dir, (SECRET,))
        self.assertFalse((self.run_dir / "report.json").exists())
        (self.run_dir / "report.json").write_text("{}", encoding="utf-8")
        cli.refuse_secret_in_report(self.run_dir, (SECRET,))
        self.assertTrue((self.run_dir / "report.json").exists())



FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
PROBE_MJS = "console.error('Error: ENOENT: no such file or directory, open \\'settings.json\\'');\nconsole.error('    at load (/tmp/x/src/load.mjs:3:9)');\nprocess.exit(1);\n"


class SeedCase(DaemonCase):
    """The lesson seed on a fake CLI: keyed publish at prepare, delete at stop, every outcome in the facts."""

    def setUp(self) -> None:
        super().setUp()
        self.lessons = self.dir / "lessons"
        self.lessons.mkdir()
        # The key the probe will derive, computed the same way from the bytes the script prints.
        self.key = signature.sig_v1("Error: ENOENT: no such file or directory, open 'settings.json'", "Error: ENOENT: no such file or directory, open 'settings.json'\n    at load (/tmp/x/src/load.mjs:3:9)")
        assert self.key is not None
        (self.lessons / "fam.md").write_text("# The lesson\n\nRun the one file.\n", encoding="utf-8")
        self.write_lesson(self.key)
        for name, value in (("PUBLISH_ARGV", lambda body, keys: [sys.executable, FAKE_CLI, *tenjin_arm.publish_argv(body, keys)[1:]]), ("DELETE_ARGV", lambda piece: [sys.executable, FAKE_CLI, *tenjin_arm.delete_argv(piece)[1:]]), ("SEARCH_ARGV", lambda query: [sys.executable, FAKE_CLI, *tenjin_arm.search_argv(query)[1:]]), ("LESSONS", self.lessons)):
            patcher = mock.patch.object(tenjin_arm, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.task = {"id": "probe", "family": "fam"}

    def write_lesson(self, key: str | None) -> None:
        (self.lessons / "fam.json").write_text(
            json.dumps(
                {
                    "id": "fam",
                    "title": "The lesson",
                    "commands": [
                        {"command": "node probe-{task}.mjs", "kind": "sig_v1", "key": key, "check": True, "reason": "stable"},
                        {"command": "node ok-{task}.mjs", "kind": "sig_v1", "key": None, "check": True, "reason": "passes"},
                    ],
                }
            ),
            encoding="utf-8",
        )

    def write_fix_lesson(self) -> str:
        """The task's own fix, keyed on the test identity vitest's FAIL header names."""
        identity = signature.TestIdentity(file="tests/probe.test.mjs", suite="probeKey", test="case 1")
        key = signature.sig_v1_test(identity)
        (self.lessons / "probe-fix.md").write_text("# The fix\n\nDefault the agent.\n", encoding="utf-8")
        (self.lessons / "probe-fix.json").write_text(
            json.dumps({"id": "probe-fix", "title": "The fix", "commands": [{"command": "node assertion-{task}.mjs", "kind": "sig_v1_test", "key": key, "check": True, "reason": "header"}]}),
            encoding="utf-8",
        )
        return key

    def seed_roots(self) -> artifact.TrialRoots:
        fixture = self.dir / "seed-fixture"
        fixture.mkdir(exist_ok=True)
        (fixture / "probe-probe.mjs").write_text(PROBE_MJS, encoding="utf-8")
        (fixture / "ok-probe.mjs").write_text("process.exit(0);\n", encoding="utf-8")
        (fixture / "assertion-probe.mjs").write_text(
            "console.log(' FAIL  tests/probe.test.mjs > probeKey > case 1');\nconsole.log(\"AssertionError: expected 's1:undefined' to be 's1:root' // Object.is equality\");\nprocess.exit(1);\n",
            encoding="utf-8",
        )
        return artifact.create(self.run_dir, "trial-seed", fixture)

    def environment(self, roots: artifact.TrialRoots) -> dict[str, str]:
        return {"PATH": os.environ.get("PATH", ""), "HOME": str(roots.home)}

    def request(self, roots: artifact.TrialRoots, nonce: str | None = "20260908T000000Z-0badf00d", **overrides: object) -> ProvisionRequest:
        base = dict(task=self.task, environment=self.environment(roots), nonce=nonce)
        base.update(overrides)
        return ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, self.source, **base)  # type: ignore[arg-type]

    def calls(self) -> list[dict]:
        path = Path(self.source.path) / "cli-calls.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_prepare_probes_publishes_with_the_key_and_stop_deletes(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots)
        provision = tenjin_arm.prepare(request)
        self.addCleanup(lambda: provision.stop_state.get("started") and runner.process_stop(provision.stop_state["started"], roots.run_dir, 2.0))
        (seed,) = provision.facts["seed"]
        self.assertEqual((seed["lesson"], seed["piece_id"], seed["published"], seed["keys"], seed["deleted"]), ("fam", "piece-1", True, 1, None))
        self.assertEqual(seed["key_hashes"], [tenjin_arm.key_hash(f"sig_v1:{self.key}")])
        self.assertEqual(seed["probe"], {"node probe-probe.mjs": tenjin_arm.key_hash(f"sig_v1:{self.key}"), "node ok-probe.mjs": None})
        self.assertNotIn(self.key, json.dumps(seed))
        self.assertFalse((roots.base / "probe").exists())
        publish = self.calls()[0]
        self.assertEqual(publish["argv"][:1] + publish["argv"][2:], ["publish", "--yes", "--json", "--key", f"fingerprint=sig_v1:{self.key}"])
        body = Path(publish["argv"][1])
        self.assertTrue(body.is_relative_to(roots.base) and not body.is_relative_to(roots.repo))
        self.assertIn(f"Benchmark seed: run 20260908T000000Z-0badf00d trial {roots.trial_id}.", body.read_text(encoding="utf-8"))
        self.assertEqual(seed["nonce"], "20260908T000000Z-0badf00d")
        self.assertIn("TENJIN_DATA_DIR", publish["env"])
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", publish["env"])
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report["seed_deleted"], {"piece-1": None})
        self.assertEqual(self.calls()[1]["argv"], ["delete", "piece-1", "--yes", "--json"])
        self.assertEqual(runner.isolation_of({"live": True}, provision, report)["seed"][0]["deleted"], True)

    def test_a_task_with_a_fix_lesson_seeds_two_pieces_under_two_kinds_and_stop_deletes_both(self) -> None:
        fix_key = self.write_fix_lesson()
        roots = self.seed_roots()
        provision = tenjin_arm.prepare(self.request(roots))
        self.addCleanup(lambda: runner.process_stop(provision.stop_state["started"], roots.run_dir, 2.0))
        seeds = provision.facts["seed"]
        self.assertEqual([(seed["lesson"], seed["piece_id"], seed["keys"]) for seed in seeds], [("fam", "piece-1", 1), ("probe-fix", "piece-2", 1)])
        self.assertEqual(seeds[1]["key_hashes"], [tenjin_arm.key_hash(f"sig_v1_test:{fix_key}")])
        self.assertEqual(seeds[1]["probe"], {"node assertion-probe.mjs": tenjin_arm.key_hash(f"sig_v1_test:{fix_key}")})
        publishes = [call["argv"] for call in self.calls() if call["argv"][0] == "publish"]
        self.assertEqual(publishes[1][2:], ["--yes", "--json", "--key", f"fingerprint=sig_v1_test:{fix_key}"])
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report["seed_deleted"], {"piece-1": None, "piece-2": None})
        isolation = runner.isolation_of({"live": True}, provision, report)
        self.assertEqual([seed["deleted"] for seed in isolation["seed"]], [True, True])
        record = support.attempt_record(support.parse("sess-family"))
        records.validate({**record, "isolation": {**record["isolation"], "seed": isolation["seed"]}})

    def test_a_second_publish_that_fails_deletes_the_first(self) -> None:
        self.write_fix_lesson()
        roots = self.seed_roots()
        source_dir = Path(self.source.path)
        (source_dir / "fail-second-publish").write_text("", encoding="utf-8")
        with self.assertRaises(ProvisionError):
            tenjin_arm.prepare(self.request(roots))
        argv = [call["argv"][:2] for call in self.calls()]
        self.assertEqual(argv[0][0], "publish")
        self.assertEqual(argv[1][0], "publish")
        self.assertEqual(argv[2], ["delete", "piece-1"])

    def test_a_delete_that_fails_is_a_fact_in_the_record(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots)
        provision = tenjin_arm.prepare(request)
        (Path(self.source.path) / "fail-delete").write_text("", encoding="utf-8")
        report = tenjin_arm.stop(roots, provision)
        self.assertIn("exited 4", report["seed_deleted"]["piece-1"])
        isolation = runner.isolation_of({"live": True}, provision, report)
        self.assertEqual((isolation["seed"][0]["deleted"], isolation["seed"][0]["piece_id"]), (False, "piece-1"))
        record = support.attempt_record(support.parse("sess-family"))
        record["isolation"] = {**record["isolation"], "seed": isolation["seed"]}
        records.validate(record)
        with self.assertRaises(records.RecordError):
            records.validate({**record, "isolation": {**record["isolation"], "seed": [{**isolation["seed"][0], "piece_id": None}]}})
        with self.assertRaises(records.RecordError):
            records.validate({**record, "isolation": {**record["isolation"], "seed": isolation["seed"][0]}})

    def test_key_drift_and_a_failed_publish_refuse_the_trial_before_the_daemon_and_mask_the_secret(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots)
        self.write_lesson("0000000000000000")
        with self.assertRaises(ProvisionError) as caught:
            tenjin_arm.prepare(request)
        self.assertIn("seed key drift", str(caught.exception))
        self.assertEqual(self.calls(), [])
        self.write_lesson(self.key)
        (Path(self.source.path) / "fail-publish").write_text("", encoding="utf-8")
        with self.assertRaises(ProvisionError) as caught:
            tenjin_arm.prepare(request)
        self.assertIn("tenjin publish exited 4", str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIn("[secret]", str(caught.exception))
        self.assertEqual(reap.read_records(roots.run_dir), [])

    def test_an_envelope_on_stderr_is_read_by_shape(self) -> None:
        roots = self.seed_roots()
        (Path(self.source.path) / "envelope-on-stderr").write_text("", encoding="utf-8")
        request = self.request(roots)
        provision = tenjin_arm.prepare(request)
        self.addCleanup(lambda: runner.process_stop(provision.stop_state["started"], roots.run_dir, 2.0))
        self.assertEqual(provision.facts["seed"][0]["piece_id"], "piece-1")
        self.assertEqual(tenjin_arm.envelope_of("", '{"ok":true,"data":{"post":{"id":"p-9"}}}'), {"ok": True, "data": {"post": {"id": "p-9"}}})
        self.assertEqual(tenjin_arm.piece_id_of({"ok": True, "data": {"post": {"id": "p-9"}}}), "p-9")
        self.assertEqual(tenjin_arm.piece_id_of({"data": {"postId": "p-8"}}), "p-8")
        self.assertIsNone(tenjin_arm.envelope_of("Published x\n", "not json"))
        self.assertIsNone(tenjin_arm.piece_id_of({"ok": True, "data": {}}))

    def test_a_publish_whose_id_cannot_be_read_sweeps_the_shelf_by_title_and_refuses(self) -> None:
        roots = self.seed_roots()
        source_dir = Path(self.source.path)
        (source_dir / "garbage-publish").write_text("", encoding="utf-8")
        (source_dir / "search-results.json").write_text(
            json.dumps([{"resourceId": "stray-1", "title": "The lesson"}, {"resourceId": "theirs", "title": "Somebody else's piece"}, {"resourceId": "stray-2", "title": "The lesson"}]),
            encoding="utf-8",
        )
        request = self.request(roots)
        with self.assertRaises(ProvisionError) as caught:
            tenjin_arm.prepare(request)
        self.assertIn("no piece id could be read", str(caught.exception))
        self.assertIn("2 matched, 2 deleted, 0 failed", str(caught.exception))
        argv = [call["argv"] for call in self.calls()]
        self.assertEqual(argv[1][:2], ["search", "The lesson"])
        self.assertEqual(argv[2:], [["delete", "stray-1", "--yes", "--json"], ["delete", "stray-2", "--yes", "--json"]])
        note = json.loads((roots.output / tenjin_arm.SEED_NOTE).read_text(encoding="utf-8"))
        self.assertEqual((note["published"], note["exit"], note["sweep"]["deleted"]), ("unknown", 0, ["stray-1", "stray-2"]))
        self.assertIn(f"trial {roots.trial_id}", note["stamp"])
        self.assertEqual(reap.read_records(roots.run_dir), [])

    def test_a_dedup_answer_is_a_refusal_and_two_runs_stamp_differently(self) -> None:
        roots = self.seed_roots()
        (Path(self.source.path) / "already-published").write_text("", encoding="utf-8")
        with self.assertRaises(ProvisionError) as caught:
            tenjin_arm.prepare(self.request(roots))
        self.assertIn("the CLI's publish dedup matched a body this machine already published; the stamp must be unique per run", str(caught.exception))
        note = json.loads((roots.output / tenjin_arm.SEED_NOTE).read_text(encoding="utf-8"))
        self.assertEqual((note["published"], note["already_published_url"]), (False, "https://team-shelf.example/a/ali/the-lesson"))
        self.assertEqual([call["argv"][0] for call in self.calls()], ["publish"])
        self.assertEqual(reap.read_records(roots.run_dir), [])
        with self.assertRaises(ProvisionError) as missing:
            tenjin_arm.prepare(self.request(roots, nonce=None))
        self.assertIn("run nonce", str(missing.exception))
        lesson = tenjin_arm.lesson_named("fam")
        assert lesson is not None
        first = tenjin_arm.seed_body(lesson, roots, "20260908T000000Z-0badf00d", roots.trial_id).read_text(encoding="utf-8")
        second = tenjin_arm.seed_body(lesson, roots, "20260908T000100Z-deadbeef", roots.trial_id).read_text(encoding="utf-8")
        self.assertNotEqual(first, second)
        self.assertEqual(first.split("Benchmark seed")[0], second.split("Benchmark seed")[0])

    def test_the_run_nonce_is_minted_once_and_reused_on_resume(self) -> None:
        manifest = support.synthetic_manifest(self.dir)  # type: ignore[arg-type]
        out = self.dir / "run-a"
        first = cli.run_nonce(out, manifest)
        self.assertRegex(first, cli.NONCE)
        self.assertEqual(cli.run_nonce(out, manifest), first)
        self.assertEqual(json.loads((out / "manifest.json").read_text(encoding="utf-8"))["nonce"], first)
        self.assertNotEqual(cli.run_nonce(self.dir / "run-b", manifest), first)

    def test_a_dry_run_states_the_seed_and_publishes_nothing(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots, nonce=None, dry_run=True, environment=None)
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
            provision = tenjin_arm.prepare(request)
        (seed,) = provision.facts["seed"]
        self.assertEqual((seed["published"], seed["piece_id"], seed["probe"], seed["key_hashes"]), (False, None, None, [tenjin_arm.key_hash(f"sig_v1:{self.key}")]))
        self.assertEqual(self.calls(), [])

    def test_a_task_without_a_lesson_seeds_nothing(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots, task={"id": "x", "family": "smoke"})
        provision = tenjin_arm.prepare(request)
        self.addCleanup(lambda: runner.process_stop(provision.stop_state["started"], roots.run_dir, 2.0))
        self.assertNotIn("seed", provision.facts)
        self.assertEqual(self.calls(), [])

    def test_an_arm_may_name_exactly_the_lessons_it_seeds(self) -> None:
        self.write_fix_lesson()
        roots = self.seed_roots()
        request = self.request(roots)
        request = ProvisionRequest(request.trial_id, request.roots, {**request.arm, "lessons": ["probe-fix"]}, request.source, task=request.task, environment=request.environment, nonce=request.nonce)
        provision = tenjin_arm.prepare(request)
        self.addCleanup(lambda: runner.process_stop(provision.stop_state["started"], roots.run_dir, 2.0))
        self.assertEqual([seed["lesson"] for seed in provision.facts["seed"]], ["probe-fix"])
        self.assertEqual(sorted(path.name for path in (roots.data_dir / "hooks").iterdir()), sorted(tenjin_arm.BUNDLES))
        self.assertIn("tenjin-vitest-reporter.mjs", tenjin_arm.BUNDLES)
        with self.assertRaises(ProvisionError):
            tenjin_arm.lessons_for(self.task, selected=["absent"])

    def test_the_key_only_lesson_shares_no_file_name_with_the_prompt(self) -> None:
        from evals.benchmark import cases

        live = tenjin_arm.FIXTURES / "live" / "lessons"
        lesson = tenjin_arm.lesson_named("actor-fix-keyonly", live)
        assert lesson is not None
        prompt = next(task for task in json.loads(cli.KEYS_SMOKE_MANIFEST.read_text(encoding="utf-8"))["tasks"])["prompt"]
        text = lesson.title + "\n" + lesson.body.read_text(encoding="utf-8")
        self.assertEqual(cases.shared_file_names(prompt, text), [])
        for word in ("actor", "actorKey", "src/actor.mjs", "tests/actor.test.mjs"):
            self.assertNotIn(word.lower(), text.lower())
        self.assertEqual(lesson.keys, ("sig_v1_test:502b90852a1505e3",))
        self.assertEqual(cases.shared_file_names(prompt, "edit src/actor.mjs"), ["actor", "actor.mjs"])

    def test_the_live_lesson_is_loadable_and_its_keys_are_the_fixture_failures(self) -> None:
        live = tenjin_arm.FIXTURES / "live" / "lessons"
        lessons = tenjin_arm.lessons_for({"id": "actor", "family": "test-harness-convention"}, live)
        self.assertEqual([lesson.id for lesson in lessons], ["test-harness-convention", "actor-fix"])
        convention, fix = lessons
        self.assertEqual(convention.keys, ("sig_v1:ee9fd96defcffbeb",))
        self.assertEqual([entry.command for entry in convention.commands if entry.check and entry.key is None], ["pnpm test -- tests/{task}.test.mjs"])
        self.assertIn("pnpm exec vitest run", convention.body.read_text(encoding="utf-8"))
        # The fix lesson carries the key run seven's fires table recorded for this failure.
        self.assertEqual(fix.keys, ("sig_v1_test:502b90852a1505e3",))
        self.assertEqual(tenjin_arm.key_hash("sig_v1:ee9fd96defcffbeb"), "ed094b3427f6e7e2")
        self.assertNotIn("s9", fix.body.read_text(encoding="utf-8"))
        self.assertEqual(tenjin_arm.lessons_for({"id": "answer-file", "family": "smoke"}, live), [])


if __name__ == "__main__":
    unittest.main()
