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

from evals.benchmark import artifact, cli, executor, reap, records, runner, schedule, tenjin_arm, vendor
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


if __name__ == "__main__":
    unittest.main()
