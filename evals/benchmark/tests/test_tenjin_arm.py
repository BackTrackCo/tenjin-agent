"""The Tenjin hooks arm: seeded data dir, the container's daemon report, and the shelf seed.

The daemon itself is the trial container's, started and stopped by the
entrypoint, so a case here writes the `daemon.json` that entrypoint leaves and
proves what the host does with it. Nothing reads an operator's data dir: the
source is a temp directory with placeholder bundles and a config written by
the case, and no case starts a container.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from evals.benchmark import artifact, cli, container, executor, images, reap, records, runner, schedule, signature, tenjin_arm
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec, ProvisionError, ProvisionRequest
from evals.benchmark.tests import support

SECRET = "bench1-test-shelf-secret-0123456789abcdef"
PASSPHRASE = "bench1-test-wallet-passphrase-fedcba9876543210"
QUESTION = "How do I run one vitest file here?"
LIVE = "live_provisioned_for_this_test"


class SourceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"
        # `load_source` reads the wallet passphrase from the environment, so a
        # machine that has one set must not decide what these cases see.
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop(tenjin_arm.WALLET_PASSPHRASE, None)

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

    def test_the_wallet_passphrase_reaches_the_runs_own_cli_calls_and_stays_out_of_everything_else(self) -> None:
        """The one credential the runner's own publish needs, and the one place it goes.

        A keystore does not hold the passphrase that opens it. An operator's
        machine answers from the OS keychain, a runner has no keychain, and
        `cli_environment` builds the child environment from scratch, so before
        this the CI publish exited non-zero with "No wallet passphrase is
        available." and every seeded attempt was refused at
        `provision:seed_publish` after the corpus reset. Nothing in a trial
        signs anything, so the value reaches the runner's own CLI calls only.
        """
        with mock.patch.dict(os.environ, {tenjin_arm.WALLET_PASSPHRASE: PASSPHRASE}):
            source = tenjin_arm.load_source(self.write_source())
        self.assertEqual(tenjin_arm.cli_environment(source, {"PATH": "/usr/bin"})[tenjin_arm.WALLET_PASSPHRASE], PASSPHRASE)
        # A tail, a case, or a scanned trial root carrying it is an exposure.
        self.assertEqual(source.secrets, (SECRET, PASSPHRASE))
        self.assertNotIn(PASSPHRASE, json.dumps(source.facts) + json.dumps(tenjin_arm.seeded_config(source, 1)))
        # The seeded run stays publishable on its own terms: a wallet's
        # passphrase is not the team shelf secret.
        self.assertEqual(source.facts["shelf_secret_present"], True)

    def test_the_preflight_names_the_address_the_source_signs_as(self) -> None:
        source = tenjin_arm.load_source(self.write_source())
        with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
            self.assertEqual(tenjin_arm.check_signing_identity(source), "0x0a3B118D0261b5b772d613DB32446FEE7b7208bC")

    def test_a_passphrase_that_opens_another_keystore_fails_the_run_not_each_trial(self) -> None:
        """One passphrase, two bench profiles: the 2026-09-09 corpus run lost all 30 seeded trials to this.

        Nothing before this asked the wallet a question, so the mismatch first
        showed up at the first seed publish, as `provision:seed_publish` on one
        trial after another while the baseline arm kept passing.
        """
        path = self.write_source()
        (path / "wrong-passphrase").touch()
        source = tenjin_arm.load_source(path)
        with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
            with self.assertRaises(tenjin_arm.ProvisionError) as caught:
                tenjin_arm.check_signing_identity(source)
        self.assertEqual(caught.exception.code, "source_wallet")
        self.assertIn("wallet.json", str(caught.exception))

    def test_the_preflight_masks_the_secrets_it_could_echo(self) -> None:
        path = self.write_source()
        (path / "wrong-passphrase").touch()
        with mock.patch.dict(os.environ, {tenjin_arm.WALLET_PASSPHRASE: PASSPHRASE}):
            source = tenjin_arm.load_source(path)
        with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
            with self.assertRaises(tenjin_arm.ProvisionError) as caught:
                tenjin_arm.check_signing_identity(source)
        self.assertNotIn(PASSPHRASE, str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))

    def test_a_machine_with_no_passphrase_sends_none(self) -> None:
        source = tenjin_arm.load_source(self.write_source())
        self.assertEqual(source.wallet_passphrase, "")
        self.assertNotIn(tenjin_arm.WALLET_PASSPHRASE, tenjin_arm.cli_environment(source, {"PATH": "/usr/bin"}))

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
        # The seven product arms, all on: the product as shipped, and no key the product does not read.
        self.assertEqual(seeded["hooks"], {arm: True for arm in ("prompt", "web-search", "web-fetch", "subagent", "failure", "publish", "primer")})
        self.assertEqual(seeded["team"], {"publicFallback": "on"})
        self.assertEqual(seeded["loop"], {"idle_exit_min": 2, "port": 4321})
        self.assertEqual(seeded["shelfBypassSecret"], SECRET)
        self.assertNotIn("wallet", seeded)
        self.assertNotIn("shelfBypassSecret", tenjin_arm.seeded_config(source, 1, with_secret=False))
        # The producer's daemon tells the capture ask to publish; there is no other mode.
        producer = tenjin_arm.seeded_config(source, 1, mode="producer")
        self.assertEqual((producer["publish"], producer["baseUrl"]), ({"mode": "auto"}, "https://team-shelf.example"))
        with self.assertRaises(ProvisionError):
            tenjin_arm.seeded_config(source, 1, mode="seed")


class DaemonCase(SourceCase):
    def setUp(self) -> None:
        super().setUp()
        self.source = tenjin_arm.load_source(self.write_source())

    def prepare(self, roots: artifact.TrialRoots, *, dry_run: bool = False) -> executor.Provision:
        request = ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, self.source, dry_run=dry_run)
        return tenjin_arm.prepare(request)

    def entrypoint(self, roots: artifact.TrialRoots, output: Path | None = None, **report: object) -> None:
        """Stand in for the container: leave the daemon report the entrypoint writes."""
        target = roots.output if output is None else output
        target.mkdir(parents=True, exist_ok=True)
        payload = {"requested": True, "started": True, "pid": 7, "port": tenjin_arm.DAEMON_PORT, "respawned": False, "wal_live": False}
        (target / tenjin_arm.DAEMON_REPORT).write_text(json.dumps({**payload, **report}) + "\n", encoding="utf-8")


class PrepareStopTest(DaemonCase):
    def test_prepare_seeds_the_data_dir_and_starts_nothing(self) -> None:
        roots = self.roots()
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("prepare starts no process")):
            provision = self.prepare(roots)
        data = roots.data_dir
        self.assertEqual(sorted(path.name for path in (data / "hooks").iterdir()), sorted(tenjin_arm.BUNDLES))
        token = (data / "daemon.token").read_text(encoding="utf-8")
        self.assertEqual(oct((data / "daemon.token").stat().st_mode & 0o777), "0o600")
        seeded = json.loads((data / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(seeded["shelfBypassSecret"], SECRET)
        self.assertEqual(seeded["team"], {"publicFallback": "on"})
        # The port is the container's loopback, and the config the daemon reads
        # inside it is the one the hook URL names.
        self.assertEqual(seeded["loop"]["port"], tenjin_arm.DAEMON_PORT)
        self.assertEqual(provision.values["daemon_url"], f"http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude")
        self.assertEqual(provision.values["daemon_token"], token)
        self.assertEqual(provision.values["data_dir"], str(data))
        self.assertEqual(provision.secrets, (SECRET,))
        self.assertEqual(provision.facts["shelf_origin"], "team-shelf.example")
        self.assertFalse((data / "daemon.pid").exists())
        # Nothing of ours is running, so the ledger is empty: the container the
        # runner starts is what the ledger will name.
        self.assertEqual(reap.read_records(roots.run_dir), [])

    def test_stop_reads_the_containers_report_and_confirms_the_wal_is_gone(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        self.entrypoint(roots, respawned=True)
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report, {"respawned": True, "started": True, "daemon_error": None, "wal_live": False})

    def test_a_wal_the_daemon_leaves_behind_is_reported_not_hidden(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        self.entrypoint(roots)
        (roots.data_dir / "loop.db-wal").write_bytes(b"wal")
        with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
            report = tenjin_arm.stop(roots, provision)
        self.assertTrue(report["wal_live"])

    def test_a_daemon_that_never_became_healthy_is_named_in_the_report(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        self.entrypoint(roots, started=False, error="the daemon did not answer /health within 15000ms")
        report = tenjin_arm.stop(roots, provision)
        self.assertFalse(report["started"])
        self.assertIn("/health", str(report["daemon_error"]))

    def test_a_container_that_left_no_report_settles_on_the_wal_alone(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report, {"respawned": False, "started": False, "daemon_error": None, "wal_live": False})

    def test_a_dry_run_seeds_without_a_secret_a_token_or_a_daemon(self) -> None:
        roots = self.roots()
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
            provision = self.prepare(roots, dry_run=True)
        self.assertFalse((roots.data_dir / "daemon.token").exists())
        seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn("shelfBypassSecret", seeded)
        self.assertEqual(provision.values["daemon_url"], f"http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude")
        self.assertEqual(provision.values["daemon_token"], tenjin_arm.DRY_TOKEN)
        self.assertEqual(provision.stop_state, {})
        self.assertEqual(tenjin_arm.stop(roots, provision)["started"], False)

    def test_the_phase_change_rewrites_the_config_and_starts_nothing(self) -> None:
        roots = self.roots()
        provision = self.prepare(roots)
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a phase change starts no process")):
            consumer = tenjin_arm.start_phase(roots, provision, "consumer")
        seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(seeded["publish"], {"mode": "review"})
        self.assertEqual(consumer.values, provision.values)
        self.assertEqual(consumer.stop_state["mode"], "consumer")


class HooksDisabledTest(DaemonCase):
    """A consumption arm runs the product with the publish nudge off, and says so in the record."""

    def prepare_with(self, arm: dict) -> executor.Provision:
        roots = self.roots()
        request = ProvisionRequest(roots.trial_id, roots, arm, self.source)
        provision = tenjin_arm.prepare(request)
        self.seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
        return provision

    def test_the_seeded_arm_runs_no_publish_nudge_and_the_record_names_it(self) -> None:
        provision = self.prepare_with({"id": "tenjin_seeded", "provision": "tenjin", "hooks_disabled": ["publish"]})
        self.assertEqual(self.seeded["hooks"]["publish"], False)
        # Every other arm the product ships is still on: this is one switch, not a quieter product.
        self.assertEqual([arm for arm, on in self.seeded["hooks"].items() if not on], ["publish"])
        self.assertEqual(provision.facts["hooks_disabled"], ["publish"])

    def test_the_natural_arm_keeps_every_arm_the_product_ships_on(self) -> None:
        provision = self.prepare_with({"id": "tenjin_natural", "provision": "tenjin", "producer": True})
        self.assertEqual(self.seeded["hooks"], {arm: True for arm in tenjin_arm.HOOK_ARMS})
        self.assertEqual(provision.facts["hooks_disabled"], [])

    def test_the_consumer_config_of_a_producer_arm_keeps_the_arms_its_producer_ran(self) -> None:
        provision = self.prepare_with({"id": "tenjin_natural", "provision": "tenjin", "producer": True})
        roots = self.roots("trial-a")
        consumer = tenjin_arm.start_phase(roots, provision, "consumer")
        self.assertEqual(consumer.stop_state["mode"], "consumer")
        self.assertEqual(json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))["hooks"]["publish"], True)

    def test_an_arm_that_names_a_hook_the_product_does_not_have_is_refused(self) -> None:
        with self.assertRaises(ProvisionError) as caught:
            self.prepare_with({"id": "tenjin_seeded", "provision": "tenjin", "hooks_disabled": ["capture"]})
        self.assertIn("no arm for", str(caught.exception))


class PublicFallbackTest(DaemonCase):
    """The one seeded value an arm may choose: whether a team miss reaches the marketplace.

    The bench shelf is reset and snapshotted per run; the public marketplace is
    the real one and moves underneath a measurement. An arm with the leg off is
    what separates the shelf's effect from the marketplace's.
    """

    def prepare_with(self, arm: dict) -> executor.Provision:
        roots = self.roots()
        provision = tenjin_arm.prepare(ProvisionRequest(roots.trial_id, roots, arm, self.source))
        self.roots_used = roots
        self.seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
        return provision

    def test_an_arm_that_names_nothing_runs_the_product_as_shipped(self) -> None:
        provision = self.prepare_with({"id": "tenjin_seeded", "provision": "tenjin"})
        self.assertEqual(self.seeded["team"], {"publicFallback": "on"})
        self.assertEqual(provision.facts["public_fallback"], "on")

    def test_the_arms_value_reaches_the_written_config_and_the_record(self) -> None:
        provision = self.prepare_with({"id": "tenjin_seeded_no_public", "provision": "tenjin", "public_fallback": "off"})
        # `src/hooks/ask.ts` reads exactly this string to drop the public legs.
        self.assertEqual(self.seeded["team"], {"publicFallback": "off"})
        self.assertEqual(provision.facts["public_fallback"], "off")
        # Nothing else moved: the two shelf arms differ in this and in nothing else.
        as_shipped = tenjin_arm.seeded_config(self.source, self.seeded["loop"]["port"])
        self.assertEqual({**self.seeded, "team": as_shipped["team"]}, as_shipped)

    def test_the_next_phase_keeps_the_value_its_first_phase_ran_under(self) -> None:
        provision = self.prepare_with({"id": "tenjin_natural", "provision": "tenjin", "producer": True, "public_fallback": "off"})
        consumer = tenjin_arm.start_phase(self.roots_used, provision, "consumer")
        self.assertEqual(consumer.stop_state["public_fallback"], "off")
        written = json.loads((self.roots_used.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(written["team"], {"publicFallback": "off"})

    def test_a_value_the_product_has_no_setting_for_is_refused(self) -> None:
        with self.assertRaises(ProvisionError) as caught:
            self.prepare_with({"id": "tenjin_seeded", "provision": "tenjin", "public_fallback": "false"})
        self.assertIn("public_fallback", str(caught.exception))


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
    """The runner's provision flow, with the fake executor's launch and no container.

    A live spec resolves its fixture image before any root exists, so the
    image lookup is the one thing these cases stub; nothing else about the
    flow is faked.
    """

    def setUp(self) -> None:
        super().setUp()
        self.image = mock.patch.object(images, "require", return_value=support.IMAGE)
        self.image.start()
        self.addCleanup(self.image.stop)
        self.export = mock.patch.object(images, "export_node_modules", return_value=0)
        self.export.start()
        self.addCleanup(self.export.stop)
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
            # What the container's daemon reads was in place before the agent
            # started, and the container reports what it did with it.
            seen.append(((roots.data_dir / "config.json").is_file(), (roots.data_dir / "daemon.token").is_file()))
            self.entrypoint(roots)

        runtime = self.runtime(spawn=support.fake_spawn(before=before))
        record = runner.run_trial(manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", runtime)
        records.validate(record)
        self.assertEqual(seen, [(True, True)])
        self.assertEqual(record["isolation"]["image"]["tag"], support.IMAGE.tag)
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

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            # A store the daemon left with its write-ahead log still beside it.
            support.write_loop_db(roots.data_dir / "loop.db", [])
            (roots.data_dir / "loop.db-wal").write_bytes(b"wal")

        with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
            record = runner.run_trial(
                manifest, self.trial(manifest, "tenjin_seeded"), self.run_dir, "sha256:schedule", self.runtime(spawn=support.fake_spawn(before=before))
            )
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
            self.assertTrue(
                any(hook.startswith(f"SubagentStart http http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude headers=Authorization") for hook in plan["hooks"])
            )
            self.assertTrue(any("tenjin-shim.mjs" in hook and hook.startswith("SessionStart command") for hook in plan["hooks"]))
        self.assertIn("shelf_secret_present=true shelf_origin=team-shelf.example", printed)
        # The image, the mount plan and the allowlist are printed, and nothing
        # was built, copied or started.
        self.assertIn("image     bench2-actor:", printed)
        self.assertIn("container bench2-", printed)
        self.assertIn("(internal, no route out) via proxy", printed)
        self.assertIn("allowlist api.anthropic.com public.example team-shelf.example", printed)
        for plan in payload["trials"]:
            self.assertEqual(plan["container"]["image"]["resolved"], False)
            self.assertEqual([mount["mode"] for mount in plan["container"]["mounts"]], ["rw"] * 5 + ["ro"])
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
    """The lesson seed on a fake CLI: keyed publish at prepare, the shortlist and the delete at stop, every outcome in the facts."""

    def setUp(self) -> None:
        super().setUp()
        self.lessons = self.dir / "lessons"
        self.lessons.mkdir()
        # The key the probe will derive, computed the same way from the bytes the script prints.
        self.key = signature.sig_v1("Error: ENOENT: no such file or directory, open 'settings.json'", "Error: ENOENT: no such file or directory, open 'settings.json'\n    at load (/tmp/x/src/load.mjs:3:9)")
        assert self.key is not None
        (self.lessons / "fam.md").write_text("# The lesson\n\nRun the one file.\n", encoding="utf-8")
        self.write_lesson(self.key)
        self.probed: list[tuple[str, str]] = []
        probe = mock.patch.object(tenjin_arm, "PROBE_RUN", self.host_probe())
        probe.start()
        self.addCleanup(probe.stop)
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
        record = {"id": "probe-fix", "title": "The fix", "commands": [{"command": "node assertion-{task}.mjs", "kind": "sig_v1_test", "key": key, "check": True, "reason": "header"}]}
        (self.lessons / "probe-fix.json").write_text(json.dumps(record), encoding="utf-8")
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

    def host_probe(self):
        """The probe seam, running the command where this suite can: on the host, in the scratch copy."""

        def run(image: str, probe: Path, command: str, environment: dict[str, str]) -> subprocess.CompletedProcess:
            self.probed.append((image, command))
            return subprocess.run(command.split(" "), cwd=probe, env=environment, capture_output=True, text=True, shell=False, check=False)

        return run

    def request(self, roots: artifact.TrialRoots, nonce: str | None = "20260908T000000Z-0badf00d", **overrides: object) -> ProvisionRequest:
        base = dict(task=self.task, environment=self.environment(roots), nonce=nonce, image=support.IMAGE.id)
        base.update(overrides)
        return ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, self.source, **base)  # type: ignore[arg-type]

    def calls(self) -> list[dict]:
        path = Path(self.source.path) / "cli-calls.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_the_probe_argv_carries_what_the_image_entrypoint_needs_to_start(self) -> None:
        """The entrypoint refuses without an output root, and refuses a container command that is not after `--`."""
        probe = self.dir / "probe"
        output = self.dir / "probe-output"
        argv = tenjin_arm.probe_argv(
            "sha256:image", probe, "pnpm exec vitest run tests/a.test.mjs", {"HOME": str(self.dir), container.OUTPUT_VAR: str(output)}
        )
        self.assertIn(f"{container.OUTPUT_VAR}={output}", argv)
        # Mounted as well as named: nothing outside a mount exists in there.
        self.assertIn(f"{output}:{output}:rw", argv)
        self.assertIn(f"{probe}:{probe}:rw", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertEqual(argv[argv.index("--") + 1 :], ["pnpm", "exec", "vitest", "run", "tests/a.test.mjs"])

    def test_the_probe_gets_its_own_output_root_and_a_copy_that_keeps_its_symlinks(self) -> None:
        roots = self.seed_roots()
        (roots.repo / "bin").mkdir()
        (roots.repo / "bin" / "runner").symlink_to(Path("..") / "probe-probe.mjs")
        seen: dict[str, object] = {}

        def run(image: str, probe: Path, command: str, environment: dict[str, str]) -> subprocess.CompletedProcess:
            link = probe / "bin" / "runner"
            seen.update(output=environment[container.OUTPUT_VAR], symlink=link.is_symlink(), target=str(link.resolve()))
            return subprocess.run(["node", str(link)], cwd=probe, env=environment, capture_output=True, text=True, shell=False, check=False)

        with mock.patch.object(tenjin_arm, "PROBE_RUN", run):
            probed = tenjin_arm.probe_keys(roots, ["node probe-probe.mjs"], self.environment(roots), support.IMAGE.id)
        # The probe's own output root, never the attempt's.
        self.assertEqual(seen["output"], str(roots.base / tenjin_arm.PROBE_OUTPUT_DIR))
        self.assertNotEqual(seen["output"], str(roots.output))
        # A dereferenced copy puts every relative link's target somewhere else,
        # which is how a pnpm `.bin` shim stops finding its own entry point.
        self.assertTrue(seen["symlink"])
        self.assertEqual(seen["target"], str((roots.base / tenjin_arm.PROBE_DIR / "probe-probe.mjs").resolve()))
        self.assertEqual(probed["node probe-probe.mjs"]["sig_v1"], self.key)
        # Both scratch roots leave with the probe.
        self.assertFalse((roots.base / tenjin_arm.PROBE_DIR).exists())
        self.assertFalse((roots.base / tenjin_arm.PROBE_OUTPUT_DIR).exists())

    def test_prepare_probes_publishes_with_the_key_and_stop_deletes(self) -> None:
        roots = self.seed_roots()
        request = self.request(roots)
        provision = tenjin_arm.prepare(request)
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

    def test_the_seeding_publish_is_given_the_passphrase_that_opens_the_wallet(self) -> None:
        """End to end, because the gap was between the workflow's environment and the child's.

        The workflow set `TENJIN_WALLET_PASSPHRASE` for `live-run` and
        `cli_environment` did not forward it, so every seeded attempt of run
        34394026777 was refused at `provision:seed_publish`. The fake CLI logs
        the names in its environment; the passphrase's presence there is what
        a real `tenjin publish` needs to sign.
        """
        with mock.patch.dict(os.environ, {tenjin_arm.WALLET_PASSPHRASE: PASSPHRASE}):
            self.source = tenjin_arm.load_source(Path(self.source.path))
        tenjin_arm.prepare(self.request(self.seed_roots()))
        publish = next(call for call in self.calls() if call["argv"][0] == "publish")
        self.assertIn(tenjin_arm.WALLET_PASSPHRASE, publish["env"])

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
        self.assertNotIn("seed", provision.facts)
        self.assertEqual(self.calls(), [])

    def test_an_arm_may_name_exactly_the_lessons_it_seeds(self) -> None:
        self.write_fix_lesson()
        roots = self.seed_roots()
        request = self.request(roots)
        request = ProvisionRequest(
            request.trial_id,
            request.roots,
            {**request.arm, "lessons": ["probe-fix"]},
            request.source,
            task=request.task,
            environment=request.environment,
            nonce=request.nonce,
            image=support.IMAGE.id,
        )
        provision = tenjin_arm.prepare(request)
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

    def write_ledger(self, roots: artifact.TrialRoots, rows: list[tuple[str, str, str, str | None, str | None]]) -> None:
        """A settled ledger in the trial's data dir: one fire per row of (id, arm, event, question, question key)."""
        db = sqlite3.connect(roots.data_dir / tenjin_arm.LOOP_DB)
        try:
            db.executescript(support.loop_ddl())
            for index, (fire_id, arm, event, question, key) in enumerate(rows, start=1):
                db.execute(
                    "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, cwd, wait, deadline_ms, elapsed_ms, reason, question, question_key)"
                    " VALUES (?, ?, 's1', 'a1', ?, 'claude', ?, ?, '/repo', 'sync', 1000, 12, 'hit', ?, ?)",
                    (fire_id, index, arm, event, f"p{index}", question, key),
                )
            db.commit()
        finally:
            db.close()

    def shelf(self, *items: dict) -> None:
        (Path(self.source.path) / "search-items.json").write_text(json.dumps(list(items)), encoding="utf-8")

    def read_shortlist(self, roots: artifact.TrialRoots) -> dict:
        return json.loads((roots.output / tenjin_arm.SHORTLIST_FILE).read_text(encoding="utf-8"))

    def test_the_shortlist_is_taken_before_the_delete_and_names_the_live_seeded_ids(self) -> None:
        roots = self.seed_roots()
        provision = tenjin_arm.prepare(self.request(roots))
        self.write_ledger(
            roots,
            [
                ("f1", "prompt", "prompt", QUESTION, None),
                ("f2", "prompt", "prompt", QUESTION, None),
                ("f3", "failure", "tool.after", "Why does the actor test fail?", "502b90852a1505e3"),
                ("f4", "failure", "tool.after", None, "502b90852a1505e3"),
            ],
        )
        self.shelf(
            {"resourceId": "piece-1", "title": "The lesson", "url": "https://team-shelf.example/p/piece-1", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1"},
            {"resourceId": "piece-real", "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False},
        )
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report["shortlist"], {"written": True, "questions": 2, "failed": 0, "error": None})
        self.assertEqual(report["seed_deleted"], {"piece-1": None})
        payload = self.read_shortlist(roots)
        self.assertEqual((payload["trial_id"], payload["seeded_piece_ids"], payload["limit"]), (roots.trial_id, ["piece-1"], 10))
        self.assertEqual(payload["shelf_origin"], "team-shelf.example")
        self.assertRegex(payload["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        # One entry per distinct question and key, in fire order; the key-only fire is not a search.
        self.assertEqual([(entry["question"], entry["question_key"], entry["fire_id"], entry["fire_event"], entry["hook_arm"]) for entry in payload["entries"]],
                         [(QUESTION, None, "f1", "prompt", "prompt"), ("Why does the actor test fail?", "502b90852a1505e3", "f3", "tool.after", "failure")])
        self.assertRegex(payload["entries"][0]["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        search = payload["entries"][0]["search"]
        self.assertEqual((search["exit"], search["error"], search["post_floor"], search["limit"], search["search_id"]), (0, None, True, 10, "search-1"))
        # The seeded piece is in the shortlist, which it can only be while it is still on the shelf.
        self.assertEqual([(c["rank"], c["id"], c["title"], c["strong"], c["confidence"], c["corroborated"]) for c in search["candidates"]],
                         [(1, "piece-1", "The lesson", True, 0.9, True), (2, "piece-real", "The convention piece", False, None, None)])
        argv = [call["argv"] for call in self.calls()]
        self.assertEqual([call[0] for call in argv], ["publish", "search", "search", "delete"])
        self.assertEqual(argv[1], ["search", QUESTION, "--json", "--limit", "10"])
        # And after the delete it is gone, which is the whole reason the snapshot exists.
        self.assertEqual(tenjin_arm.search_shortlist(self.source, QUESTION)["candidates"][0]["id"], "piece-real")

    def test_a_search_that_fails_is_recorded_for_that_question_and_the_trial_still_stops(self) -> None:
        roots = self.seed_roots()
        provision = tenjin_arm.prepare(self.request(roots))
        self.write_ledger(roots, [("f1", "prompt", "prompt", QUESTION, None)])
        (Path(self.source.path) / "fail-search").write_text("", encoding="utf-8")
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual(report["shortlist"], {"written": True, "questions": 1, "failed": 1, "error": None})
        self.assertEqual(report["seed_deleted"], {"piece-1": None})
        search = self.read_shortlist(roots)["entries"][0]["search"]
        self.assertEqual((search["exit"], search["candidates"]), (4, []))
        self.assertIn("search refused: 502", search["error"])

    def test_a_trial_with_no_ledger_writes_an_empty_shortlist_and_an_unreadable_one_is_not_fatal(self) -> None:
        roots = self.seed_roots()
        provision = tenjin_arm.prepare(self.request(roots))
        report = tenjin_arm.stop(roots, provision)
        self.assertEqual((report["shortlist"]["written"], report["shortlist"]["questions"]), (True, 0))
        self.assertEqual(self.read_shortlist(roots)["entries"], [])
        self.assertEqual(report["seed_deleted"], {"piece-1": None})
        roots.data_dir.joinpath(tenjin_arm.LOOP_DB).write_bytes(b"not a database")
        report = tenjin_arm.stop(roots, provision)
        self.assertFalse(report["shortlist"]["written"])
        self.assertIn("DatabaseError", report["shortlist"]["error"])
        self.assertEqual(report["seed_deleted"], {"piece-1": None})

    def test_the_shortlist_masks_the_shelf_secret(self) -> None:
        roots = self.seed_roots()
        provision = tenjin_arm.prepare(self.request(roots))
        self.write_ledger(roots, [("f1", "prompt", "prompt", QUESTION, None)])
        self.shelf({"resourceId": "piece-1", "title": f"The lesson {SECRET}", "url": "https://team-shelf.example/p/piece-1", "strong": True})
        tenjin_arm.stop(roots, provision)
        text = (roots.output / tenjin_arm.SHORTLIST_FILE).read_text(encoding="utf-8")
        self.assertNotIn(SECRET, text)
        self.assertIn("[secret]", text)


def _post(url: str, token: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status in (200, 204)
    time.sleep(0.005)


def _failure_then_fix(url: str, token: str, session: str, cwd: str, command: str, failure_text: str, edited_file: str) -> None:
    """The five hook events a producer's fix looks like to the daemon: a failing Bash call, an edit, the same call passing."""
    base = {"session_id": session, "cwd": cwd, "transcript_path": "t"}
    _post(url, token, {**base, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "tool_use_id": "p-fail"})
    _post(url, token, {**base, "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": {"command": command}, "tool_use_id": "p-fail", "error": failure_text, "is_interrupt": False})
    _post(url, token, {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": edited_file}, "tool_use_id": "p-edit"})
    _post(url, token, {**base, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "tool_use_id": "p-pass"})
    _post(url, token, {**base, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "tool_use_id": "p-pass", "tool_response": {"stdout": "1 passed", "stderr": "", "interrupted": False}})


FAKE_DAEMON = [sys.executable, str(Path(__file__).with_name("fake_daemon.py"))]


class ProducerTest(RunnerCase):
    """The natural arm: a verified producer session on the same store, then the consumer on a fresh copy.

    The daemon a phase runs is the container's. These cases stand in for that
    container: they start `tests/fake_daemon.py` on the mounted data dir for
    the length of the attempt, post the phase's hook events to it, stop it, and
    leave the `daemon.json` the entrypoint would leave.
    """

    def start_daemon(self, roots: artifact.TrialRoots) -> tuple[subprocess.Popen, str, str]:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(roots.home), "TENJIN_DATA_DIR": os.path.abspath(roots.data_dir)}
        process = subprocess.Popen(FAKE_DAEMON, cwd=roots.data_dir, env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        end = time.monotonic() + 10
        record: dict | None = None
        while time.monotonic() < end:
            try:
                record = json.loads((roots.data_dir / "daemon.pid").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                record = None
            if record and record.get("pid") == process.pid:
                break
            time.sleep(0.02)
        assert record is not None and record.get("pid") == process.pid, "the stand-in daemon never announced itself"
        token = (roots.data_dir / "daemon.token").read_text(encoding="utf-8")
        return process, f"http://127.0.0.1:{record['port']}/hook/claude", token

    def stop_daemon(self, roots: artifact.TrialRoots, process: subprocess.Popen) -> None:
        process.terminate()
        process.wait(timeout=10)
        roots.output.mkdir(parents=True, exist_ok=True)
        (roots.output / tenjin_arm.DAEMON_REPORT).write_text(
            json.dumps({"requested": True, "started": True, "pid": process.pid, "respawned": False, "wal_live": False}) + "\n", encoding="utf-8"
        )

    def natural_manifest(self) -> object:
        manifest = support.synthetic_manifest(self.dir, executor_name=LIVE, arms=("off", "tenjin_natural"))  # type: ignore[arg-type]
        manifest.data["arms"][1].update({"provision": "tenjin", "producer": True})
        return manifest

    def producer_spawn(self, *, fix: bool = True, capture: bool = True) -> runner.Spawn:
        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            if roots.phase != "producer":
                return
            process, url, token = self.start_daemon(roots)
            self.daemon = process
            if capture:
                _failure_then_fix(url, token, launch.root_session_id, str(launch.cwd), "node assertion-x.mjs", " FAIL  tests/x.test.mjs > x > case 1\nAssertionError: expected 1 to be 2\n", f"{launch.cwd}/src/x.mjs")
                _post(url, token, {"session_id": launch.root_session_id, "cwd": str(launch.cwd), "transcript_path": "t", "hook_event_name": "Stop", "stop_hook_active": False})

        def after(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            if roots.phase != "producer":
                return
            self.stop_daemon(roots, self.daemon)
            if not fix:
                (roots.repo / "answer.txt").write_text("41\n", encoding="utf-8")
            # The fake executor reuses request ids per session; a real harness mints unique ones.
            for path in (roots.output / "sessions").rglob("*.jsonl"):
                path.write_text(path.read_text(encoding="utf-8").replace('"req_', '"producer_req_'), encoding="utf-8")

        return support.fake_spawn(before=before, after=after)

    def test_the_producer_runs_first_is_verified_and_its_capture_reaches_the_consumer(self) -> None:
        manifest = self.natural_manifest()
        spawns: list[str | None] = []
        base = self.producer_spawn()

        def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
            spawns.append(roots.phase)
            return base(launch, roots, timeout_s)

        record = runner.run_trial(manifest, self.trial(manifest, "tenjin_natural"), self.run_dir, "sha256:schedule", self.runtime(spawn=spawn))
        records.validate(record)
        self.assertEqual(spawns, ["producer", None])
        self.assertEqual(record["outcome"], "pass")
        produced = record["isolation"]["producer"]
        self.assertEqual((produced["outcome"], produced["daemon"], produced["wal_live_between_phases"], produced["stop_reason"]), ("pass", "restarted", False, "exit"))
        self.assertEqual(produced["verifier"], {"id": "fake_answer_file", "exit_code": 0})
        self.assertEqual(produced["capture"]["pairings"], {"open": 0, "unverified": 1, "verified": 0})
        self.assertEqual((produced["capture"]["turn_end_fires"], produced["capture"]["fires"]), (1, 2))
        self.assertEqual(produced["usage_reconciliation"], {"status": "matched"})
        self.assertGreater(produced["tokens"]["input_total"], 0)
        self.assertEqual(produced["phase_tokens"]["capture"], 0)
        self.assertEqual({receipt["component"] for receipt in record["auxiliary"]}, {"producer"})
        self.assertEqual({receipt["phase"] for receipt in record["auxiliary"]}, {"producer"})
        self.assertEqual(sum(receipt["input_total"] + receipt["output_total"] for receipt in record["auxiliary"]), produced["tokens"]["input_total"] + produced["tokens"]["output_total"])
        self.assertEqual(record["delivery"]["phase_fires"], {produced["native_root_id"]: 2})
        self.assertEqual(record["delivery"]["unmatched_fires"], [])
        self.assertNotEqual(produced["native_root_id"], record["native_root_id"])
        # Producer roots beside the consumer's, on the shared data dir; the consumer's repository was fresh.
        trial_dir = self.run_dir / "trials" / record["trial_id"]
        self.assertTrue((trial_dir / "producer" / "output" / "sessions").is_dir())
        self.assertTrue((trial_dir / "producer" / "verify").is_dir())
        self.assertEqual(reap.read_records(self.run_dir), [])
        self.assertNotIn(SECRET, json.dumps(record))

    def test_a_producer_that_does_not_fix_the_task_makes_the_attempt_invalid_and_starts_no_consumer(self) -> None:
        manifest = self.natural_manifest()
        spawns: list[str | None] = []
        base = self.producer_spawn(fix=False)

        def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
            spawns.append(roots.phase)
            return base(launch, roots, timeout_s)

        record = runner.run_trial(manifest, self.trial(manifest, "tenjin_natural"), self.run_dir, "sha256:schedule", self.runtime(spawn=spawn))
        records.validate(record)
        self.assertEqual(spawns, ["producer"])
        self.assertEqual((record["outcome"], record["invalid_reason"]), ("invalid", "producer:failed"))
        self.assertEqual(record["isolation"]["producer"]["outcome"], "invalid")
        self.assertEqual(record["isolation"]["producer"]["verifier"]["exit_code"], 1)
        self.assertEqual(reap.read_records(self.run_dir), [])

    def test_a_producer_that_captured_nothing_is_a_valid_natural_attempt(self) -> None:
        manifest = self.natural_manifest()
        record = runner.run_trial(manifest, self.trial(manifest, "tenjin_natural"), self.run_dir, "sha256:schedule", self.runtime(spawn=self.producer_spawn(capture=False)))
        records.validate(record)
        self.assertEqual(record["outcome"], "pass")
        self.assertEqual(record["isolation"]["producer"]["capture"]["pairings"], {"open": 0, "unverified": 0, "verified": 0})
        self.assertEqual(record["delivery"].get("phase_fires"), {})

    def test_producer_requests_from_the_first_turn_end_on_are_capture_cost(self) -> None:
        from evals.benchmark import producer, usage

        def record(request_id: str) -> usage.UsageRecord:
            return usage.from_json(
                {
                    "adapter": "claude",
                    "adapter_version": "1",
                    "trial_id": "t",
                    "actor_key": ["claude", "s", ""],
                    "native_request_id": request_id,
                    "input_total": 10,
                    "uncached_input": None,
                    "cache_read": None,
                    "cache_write": None,
                    "output_total": 5,
                    "reasoning_output_subset": None,
                    "provider_total": None,
                    "native_request_cost": None,
                    "completion_state": "complete",
                    "source_hash": "sha256:x",
                }
            )

        times = {"a": 1000, "b": 2000, "c": 3000}
        receipts = producer.receipts_of("t", [record("a"), record("b"), record("c"), record("d")], times, 2000)
        self.assertEqual([(receipt.native_request_id, receipt.phase) for receipt in receipts], [("a", "producer"), ("b", "capture"), ("c", "capture"), ("d", "producer")])
        self.assertEqual(producer.phase_tokens(receipts), {"producer": 30, "capture": 30})
        self.assertEqual({receipt.phase for receipt in producer.receipts_of("t", [record("a")], times, None)}, {"producer"})
        transcript = self.dir / "root.jsonl"
        transcript.write_text('{"requestId": "r1", "timestamp": "2026-09-08T00:00:01.500Z"}\n{"requestId": "r1", "timestamp": "2026-09-08T00:00:09Z"}\nnot json\n{"requestId": "r2"}\n', encoding="utf-8")
        self.assertEqual(producer.request_times(transcript), {"r1": 1788825601500})


class PublicOriginTest(unittest.TestCase):
    def test_a_config_without_a_public_shelf_url_still_allowlists_the_product_default(self) -> None:
        """Silence in the config is not silence on the wire.

        The product falls back to its production origin, so an allowlist built
        from the config alone refused the public leg and the refusal threw the
        trial away as a public request.
        """
        source = tenjin_arm.Source(path=Path("."), config={"baseUrl": "https://shelf.example"}, bundles={})
        self.assertEqual(source.public_origin, "tenjin.blog")
        self.assertEqual(source.origins, ("shelf.example", "tenjin.blog"))

    def test_a_named_public_shelf_url_wins(self) -> None:
        source = tenjin_arm.Source(
            path=Path("."),
            config={"baseUrl": "https://shelf.example", "publicShelfUrl": "https://public.example"},
            bundles={},
        )
        self.assertEqual(source.origins, ("shelf.example", "public.example"))


class UpdateCheckTest(unittest.TestCase):
    """The CLI's daily npm check is off in every trial process.

    Left on, it makes one request to a host no arm asked for. The proxy refuses
    it, the sentinel counts the refusal, and a trial that did its work correctly
    is thrown away.
    """

    def test_the_cli_and_the_daemon_environments_both_turn_the_npm_check_off(self) -> None:
        source = tenjin_arm.dry_source()
        cli = tenjin_arm.cli_environment(source, {"PATH": "/usr/bin", "HOME": "/home/u"})
        self.assertEqual(cli[tenjin_arm.NO_UPDATE_CHECK], "1")
        fixture = Path(tempfile.mkdtemp())
        (fixture / "keep.txt").write_text("x", encoding="utf-8")
        roots = artifact.create(Path(tempfile.mkdtemp()), "t1", fixture)
        daemon = tenjin_arm.daemon_environment(roots, {"PATH": "/usr/bin"})
        self.assertEqual(daemon[tenjin_arm.NO_UPDATE_CHECK], "1")

    def test_the_daemon_environment_carries_the_run_proxy_and_the_flag_that_makes_it_count(self) -> None:
        fixture = Path(tempfile.mkdtemp())
        (fixture / "keep.txt").write_text("x", encoding="utf-8")
        roots = artifact.create(Path(tempfile.mkdtemp()), "t2", fixture)
        parent = {
            "PATH": "/usr/bin",
            "HTTPS_PROXY": "http://proxy:8888",
            "https_proxy": "http://proxy:8888",
            "NO_PROXY": "127.0.0.1,localhost",
            "NODE_USE_ENV_PROXY": "1",
            "AWS_SECRET_ACCESS_KEY": "nope",
        }
        env = tenjin_arm.daemon_environment(roots, parent)
        self.assertEqual(env["HTTPS_PROXY"], "http://proxy:8888")
        self.assertEqual(env["https_proxy"], "http://proxy:8888")
        self.assertEqual(env["NO_PROXY"], "127.0.0.1,localhost")
        self.assertEqual(env["NODE_USE_ENV_PROXY"], "1")
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)


class CallerUserAgentTest(unittest.TestCase):
    """The run's identity to the product, and the two host environments that carry it.

    A public leg the marketplace cannot tell from a person's question is counted
    as demand and ranks on a public page. The field that separates them is the
    User-Agent, and the only client label the server reads is the LEADING
    product, so every case here judges the head of the field.
    """

    NONCE = "20260909T010203Z-deadbeef"

    def roots(self, trial_id: str) -> artifact.TrialRoots:
        fixture = Path(tempfile.mkdtemp())
        (fixture / "keep.txt").write_text("x", encoding="utf-8")
        return artifact.create(Path(tempfile.mkdtemp()), trial_id, fixture)

    def test_the_leading_product_is_the_eval_product_and_the_version_names_the_run(self) -> None:
        value = tenjin_arm.caller_user_agent(self.NONCE)
        name, version = tenjin_arm.leading_product(value)
        self.assertEqual(name, tenjin_arm.EVAL_PRODUCT)
        self.assertEqual(version, f"{tenjin_arm.BENCH_PRODUCT}-{self.NONCE}")
        self.assertTrue(tenjin_arm.leads_with_eval(value))

    def test_the_version_still_fits_the_field_the_server_keeps_it_in(self) -> None:
        """32 characters survive there and this value fills exactly that, so a longer nonce truncates silently."""
        _, version = tenjin_arm.leading_product(tenjin_arm.caller_user_agent(self.NONCE))
        self.assertLessEqual(len(version or ""), tenjin_arm.PRODUCT_VERSION_LIMIT)

    def test_the_nonce_a_run_mints_survives_inside_a_product_token(self) -> None:
        """A character the server's token alphabet excludes would cut the field short, so the two shapes are pinned together."""
        self.assertTrue(cli.NONCE.match(self.NONCE))
        self.assertTrue(tenjin_arm.leads_with_eval(tenjin_arm.caller_user_agent(self.NONCE)))

    def test_an_absent_or_wrongly_led_field_is_not_the_eval_product(self) -> None:
        composed = f"tenjin-cli/0.1.0-alpha.15 {tenjin_arm.caller_user_agent(self.NONCE)} (+https://tenjin.blog)"
        # `composed` is the field the product's own handoff produces today: the
        # CLI's identity leads and the eval product rides behind it, which the
        # server reads as `tenjin-cli`. See the README section on the gap.
        for value in (None, "", "tenjin-cli/0.1.0-alpha.15", composed, "tenjin-evaluation/1", " tenjin-eval/1"):
            self.assertFalse(tenjin_arm.leads_with_eval(value), value)

    def test_the_eval_product_is_matched_the_way_the_demand_gate_matches_it(self) -> None:
        """The gate lowers the stored token, so a capitalised spelling is the same client, not a different one."""
        self.assertTrue(tenjin_arm.leads_with_eval("Tenjin-Eval/1"))

    def test_the_seeding_cli_environment_carries_it(self) -> None:
        value = tenjin_arm.caller_user_agent(self.NONCE)
        parent = {"PATH": "/usr/bin", "HOME": "/home/u", tenjin_arm.CALLER_USER_AGENT: value}
        self.assertEqual(tenjin_arm.cli_environment(tenjin_arm.dry_source(), parent)[tenjin_arm.CALLER_USER_AGENT], value)

    def test_the_daemon_environment_carries_it(self) -> None:
        value = tenjin_arm.caller_user_agent(self.NONCE)
        parent = {"PATH": "/usr/bin", tenjin_arm.CALLER_USER_AGENT: value}
        self.assertEqual(tenjin_arm.daemon_environment(self.roots("ua1"), parent)[tenjin_arm.CALLER_USER_AGENT], value)

    def test_neither_environment_invents_one_the_parent_does_not_have(self) -> None:
        """A default here would name every run the same and hide the case the refusals exist for."""
        self.assertNotIn(tenjin_arm.CALLER_USER_AGENT, tenjin_arm.cli_environment(tenjin_arm.dry_source(), {"PATH": "/usr/bin"}))
        self.assertNotIn(tenjin_arm.CALLER_USER_AGENT, tenjin_arm.daemon_environment(self.roots("ua2"), {"PATH": "/usr/bin"}))


if __name__ == "__main__":
    unittest.main()
