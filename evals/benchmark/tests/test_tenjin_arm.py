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
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest import mock

import pytest
from inline_snapshot import snapshot

from evals.benchmark import artifact, cases, cli, container, executor, manifest as manifest_module, producer, records, runner, schedule, signature, tenjin_arm, usage, verifier
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec, ProvisionError, ProvisionRequest
from evals.benchmark.tests import support

FAKE_DAEMON = [sys.executable, str(Path(__file__).with_name("fake_daemon.py"))]
FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
SECRET = "bench1-test-shelf-secret-0123456789abcdef"
PASSPHRASE = "bench1-test-wallet-passphrase-fedcba9876543210"
QUESTION = "How do I run one vitest file here?"
LIVE = "live_provisioned_for_this_test"
TASK = {"id": "probe", "family": "fam"}
PROBE_MJS = "console.error('Error: ENOENT: no such file or directory, open \\'settings.json\\'');\nconsole.error('    at load (/tmp/x/src/load.mjs:3:9)');\nprocess.exit(1);\n"

WriteSource = Callable[..., Path]
Prepare = Callable[..., executor.Provision]
Entrypoint = Callable[..., None]


@pytest.fixture(autouse=True)
def _no_operator_passphrase() -> Iterator[None]:
    """`load_source` reads the wallet passphrase from the environment, so a
    machine that has one set must not decide what these cases see."""
    with mock.patch.dict(os.environ):
        os.environ.pop(tenjin_arm.WALLET_PASSPHRASE, None)
        yield


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    return tmp_path / "run"


@pytest.fixture
def write_source(tmp_path: Path) -> WriteSource:
    """A Tenjin source directory, with the bundles and the config a case wants."""

    def write(config: dict | None = None, bundles: bool = True) -> Path:
        source = tmp_path / "source"
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

    return write


@pytest.fixture
def make_roots(tmp_path: Path, run_dir: Path) -> Callable[..., artifact.TrialRoots]:
    def build(trial: str = "trial-a") -> artifact.TrialRoots:
        fixture = tmp_path / "fixture"
        fixture.mkdir(exist_ok=True)
        (fixture / "TASK.md").write_text("task\n", encoding="utf-8")
        return artifact.create(run_dir, trial, fixture)

    return build


def test_only_the_copied_keys_are_read_and_the_secret_is_a_fact_not_a_value(write_source: WriteSource) -> None:
    source = tenjin_arm.load_source(write_source())
    assert sorted(source.config) == ["baseUrl", "publicShelfUrl", "shelfBypassSecret"]
    assert source.shelf_secret_present
    assert source.facts == {"shelf_secret_present": True, "shelf_origin": "team-shelf.example", "public_origin": "public.example"}
    assert source.origins == ("team-shelf.example", "public.example")
    assert source.secrets == (SECRET,)
    assert SECRET not in json.dumps(source.facts)


def test_the_wallet_passphrase_reaches_the_runs_own_cli_calls_and_stays_out_of_everything_else(write_source: WriteSource) -> None:
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
        source = tenjin_arm.load_source(write_source())
    assert tenjin_arm.cli_environment(source, {"PATH": "/usr/bin"})[tenjin_arm.WALLET_PASSPHRASE] == PASSPHRASE
    # A tail, a case, or a scanned trial root carrying it is an exposure.
    assert source.secrets == (SECRET, PASSPHRASE)
    assert PASSPHRASE not in json.dumps(source.facts) + json.dumps(tenjin_arm.seeded_config(source, 1))
    # The seeded run stays publishable on its own terms: a wallet's
    # passphrase is not the team shelf secret.
    assert source.facts["shelf_secret_present"] is True


def test_the_preflight_names_the_address_the_source_signs_as(write_source: WriteSource) -> None:
    source = tenjin_arm.load_source(write_source())
    with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
        assert tenjin_arm.check_signing_identity(source) == "0x0a3B118D0261b5b772d613DB32446FEE7b7208bC"


def test_a_passphrase_that_opens_another_keystore_fails_the_run_not_each_trial(write_source: WriteSource) -> None:
    """One passphrase, two bench profiles: the 2026-09-09 corpus run lost all 30 seeded trials to this.

    Nothing before this asked the wallet a question, so the mismatch first
    showed up at the first seed publish, as `provision:seed_publish` on one
    trial after another while the baseline arm kept passing.
    """
    path = write_source()
    (path / "wrong-passphrase").touch()
    source = tenjin_arm.load_source(path)
    with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
        with pytest.raises(tenjin_arm.ProvisionError) as caught:
            tenjin_arm.check_signing_identity(source)
    assert caught.value.code == "source_wallet"
    assert "wallet.json" in str(caught.value)


def test_the_preflight_masks_the_secrets_it_could_echo(write_source: WriteSource) -> None:
    path = write_source()
    (path / "wrong-passphrase").touch()
    with mock.patch.dict(os.environ, {tenjin_arm.WALLET_PASSPHRASE: PASSPHRASE}):
        source = tenjin_arm.load_source(path)
    with mock.patch.object(tenjin_arm, "PROFILE_ARGV", lambda: [sys.executable, FAKE_CLI, "profile", "--json"]):
        with pytest.raises(tenjin_arm.ProvisionError) as caught:
            tenjin_arm.check_signing_identity(source)
    assert PASSPHRASE not in str(caught.value)
    assert SECRET not in str(caught.value)


def test_a_machine_with_no_passphrase_sends_none(write_source: WriteSource) -> None:
    source = tenjin_arm.load_source(write_source())
    assert source.wallet_passphrase == ""
    assert tenjin_arm.WALLET_PASSPHRASE not in tenjin_arm.cli_environment(source, {"PATH": "/usr/bin"})


def test_a_source_without_a_secret_is_public_mode(write_source: WriteSource) -> None:
    source = tenjin_arm.load_source(write_source({"baseUrl": "https://tenjin.blog"}))
    assert not source.shelf_secret_present
    assert source.secrets == ()
    assert source.facts["shelf_origin"] == "tenjin.blog"


@pytest.mark.parametrize(
    "edit",
    [
        pytest.param(dict(bundles=False), id="no bundles"),
        pytest.param(dict(config={"shelfBypassSecret": SECRET}), id="no baseUrl"),
        pytest.param(dict(config={"baseUrl": "https://x.example", "shelfBypassSecret": 1}), id="secret that is not a string"),
    ],
)
def test_a_source_that_cannot_seed_a_trial_is_refused(write_source: WriteSource, edit: dict) -> None:
    with pytest.raises(ProvisionError):
        tenjin_arm.load_source(write_source(**edit))


def test_an_absent_source_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ProvisionError):
        tenjin_arm.load_source(tmp_path / "absent")


def test_the_seeded_config_forces_the_constants_and_carries_the_port(write_source: WriteSource) -> None:
    source = tenjin_arm.load_source(write_source())
    seeded = tenjin_arm.seeded_config(source, 4321)
    assert seeded["publish"] == {"mode": "review"}
    # The seven product arms, all on: the product as shipped, and no key the product does not read.
    assert seeded["hooks"] == {arm: True for arm in ("prompt", "web-search", "web-fetch", "subagent", "failure", "publish", "primer")}
    assert seeded["team"] == {"publicFallback": "on"}
    assert seeded["loop"] == {"idle_exit_min": 2, "port": 4321}
    assert seeded["shelfBypassSecret"] == SECRET
    assert "wallet" not in seeded
    assert "shelfBypassSecret" not in tenjin_arm.seeded_config(source, 1, with_secret=False)
    # The producer's daemon tells the capture ask to publish; there is no other mode.
    producer_config = tenjin_arm.seeded_config(source, 1, mode="producer")
    assert (producer_config["publish"], producer_config["baseUrl"]) == ({"mode": "auto"}, "https://team-shelf.example")
    with pytest.raises(ProvisionError):
        tenjin_arm.seeded_config(source, 1, mode="seed")


@pytest.fixture
def source(write_source: WriteSource) -> tenjin_arm.Source:
    return tenjin_arm.load_source(write_source())


@pytest.fixture
def prepare(source: tenjin_arm.Source) -> Prepare:
    def run(roots: artifact.TrialRoots, *, dry_run: bool = False) -> executor.Provision:
        return tenjin_arm.prepare(ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, source, dry_run=dry_run))

    return run


@pytest.fixture
def entrypoint() -> Entrypoint:
    """Stand in for the container: leave the daemon report the entrypoint writes."""

    def write(roots: artifact.TrialRoots, output: Path | None = None, **report: object) -> None:
        target = roots.output if output is None else output
        target.mkdir(parents=True, exist_ok=True)
        payload = {"requested": True, "started": True, "pid": 7, "port": tenjin_arm.DAEMON_PORT, "respawned": False, "wal_live": False}
        (target / tenjin_arm.DAEMON_REPORT).write_text(json.dumps({**payload, **report}) + "\n", encoding="utf-8")

    return write


def test_prepare_seeds_the_data_dir_and_starts_nothing(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("prepare starts no process")):
        provision = prepare(roots)
    data = roots.data_dir
    assert sorted(path.name for path in (data / "hooks").iterdir()) == sorted(tenjin_arm.BUNDLES)
    token = (data / "daemon.token").read_text(encoding="utf-8")
    assert oct((data / "daemon.token").stat().st_mode & 0o777) == "0o600"
    seeded = json.loads((data / "config.json").read_text(encoding="utf-8"))
    assert seeded["shelfBypassSecret"] == SECRET
    assert seeded["team"] == {"publicFallback": "on"}
    # The port is the container's loopback, and the config the daemon reads
    # inside it is the one the hook URL names.
    assert seeded["loop"]["port"] == tenjin_arm.DAEMON_PORT
    assert provision.values["daemon_url"] == f"http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude"
    assert provision.values["daemon_token"] == token
    assert provision.values["data_dir"] == str(data)
    assert provision.secrets == (SECRET,)
    assert provision.facts["shelf_origin"] == "team-shelf.example"
    assert not (data / "daemon.pid").exists()


def test_stop_reads_the_containers_report_and_confirms_the_wal_is_gone(make_roots, prepare: Prepare, entrypoint: Entrypoint) -> None:
    roots = make_roots()
    provision = prepare(roots)
    entrypoint(roots, respawned=True)
    report = tenjin_arm.stop(roots, provision)
    assert report == {"respawned": True, "started": True, "daemon_error": None, "wal_live": False}


def test_a_wal_the_daemon_leaves_behind_is_reported_not_hidden(make_roots, prepare: Prepare, entrypoint: Entrypoint) -> None:
    roots = make_roots()
    provision = prepare(roots)
    entrypoint(roots)
    (roots.data_dir / "loop.db-wal").write_bytes(b"wal")
    with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
        report = tenjin_arm.stop(roots, provision)
    assert report["wal_live"]


def test_a_daemon_that_never_became_healthy_is_named_in_the_report(make_roots, prepare: Prepare, entrypoint: Entrypoint) -> None:
    roots = make_roots()
    provision = prepare(roots)
    entrypoint(roots, started=False, error="the daemon did not answer /health within 15000ms")
    report = tenjin_arm.stop(roots, provision)
    assert not report["started"]
    assert "/health" in str(report["daemon_error"])


def test_a_container_that_left_no_report_settles_on_the_wal_alone(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    provision = prepare(roots)
    report = tenjin_arm.stop(roots, provision)
    assert report == {"respawned": False, "started": False, "daemon_error": None, "wal_live": False}


def test_a_dry_run_seeds_without_a_secret_a_token_or_a_daemon(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        provision = prepare(roots, dry_run=True)
    assert not (roots.data_dir / "daemon.token").exists()
    seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
    assert "shelfBypassSecret" not in seeded
    assert provision.values["daemon_url"] == f"http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude"
    assert provision.values["daemon_token"] == tenjin_arm.DRY_TOKEN
    assert provision.stop_state == {}
    assert tenjin_arm.stop(roots, provision)["started"] is False


def test_the_phase_change_rewrites_the_config_and_starts_nothing(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    provision = prepare(roots)
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a phase change starts no process")):
        consumer = tenjin_arm.start_phase(roots, provision, "consumer")
    seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
    assert seeded["publish"] == {"mode": "review"}
    assert consumer.values == provision.values
    assert consumer.stop_state["mode"] == "consumer"


PrepareArm = Callable[[dict], tuple[executor.Provision, artifact.TrialRoots, dict]]


@pytest.fixture
def prepare_arm(source: tenjin_arm.Source, make_roots) -> PrepareArm:
    """One arm through `prepare`, with the roots it seeded and the config it wrote."""

    def run(arm: dict) -> tuple[executor.Provision, artifact.TrialRoots, dict]:
        roots = make_roots()
        provision = tenjin_arm.prepare(ProvisionRequest(roots.trial_id, roots, arm, source))
        return provision, roots, json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))

    return run


# A consumption arm runs the product with the publish nudge off, and says so in the record.


def test_the_seeded_arm_runs_no_publish_nudge_and_the_record_names_it(prepare_arm: PrepareArm) -> None:
    provision, _, seeded = prepare_arm({"id": "tenjin_seeded", "provision": "tenjin", "hooks_disabled": ["publish"]})
    assert seeded["hooks"]["publish"] is False
    # Every other arm the product ships is still on: this is one switch, not a quieter product.
    assert [arm for arm, on in seeded["hooks"].items() if not on] == ["publish"]
    assert provision.facts["hooks_disabled"] == ["publish"]


def test_the_natural_arm_keeps_every_arm_the_product_ships_on(prepare_arm: PrepareArm) -> None:
    provision, _, seeded = prepare_arm({"id": "tenjin_natural", "provision": "tenjin", "producer": True})
    assert seeded["hooks"] == {arm: True for arm in tenjin_arm.HOOK_ARMS}
    assert provision.facts["hooks_disabled"] == []


def test_the_consumer_config_of_a_producer_arm_keeps_the_arms_its_producer_ran(prepare_arm: PrepareArm) -> None:
    provision, roots, _ = prepare_arm({"id": "tenjin_natural", "provision": "tenjin", "producer": True})
    consumer = tenjin_arm.start_phase(roots, provision, "consumer")
    assert consumer.stop_state["mode"] == "consumer"
    assert json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))["hooks"]["publish"] is True


def test_an_arm_that_names_a_hook_the_product_does_not_have_is_refused(prepare_arm: PrepareArm) -> None:
    with pytest.raises(ProvisionError) as caught:
        prepare_arm({"id": "tenjin_seeded", "provision": "tenjin", "hooks_disabled": ["capture"]})
    assert "no arm for" in str(caught.value)


# The one seeded value an arm may choose: whether a team miss reaches the marketplace.
#
# The bench shelf is reset and snapshotted per run; the public marketplace is
# the real one and moves underneath a measurement. An arm with the leg off is
# what separates the shelf's effect from the marketplace's.


def test_an_arm_that_names_nothing_runs_the_product_as_shipped(prepare_arm: PrepareArm) -> None:
    provision, _, seeded = prepare_arm({"id": "tenjin_seeded", "provision": "tenjin"})
    assert seeded["team"] == {"publicFallback": "on"}
    assert provision.facts["public_fallback"] == "on"


def test_the_arms_value_reaches_the_written_config_and_the_record(prepare_arm: PrepareArm, source: tenjin_arm.Source) -> None:
    provision, _, seeded = prepare_arm({"id": "tenjin_seeded_no_public", "provision": "tenjin", "public_fallback": "off"})
    # `src/hooks/ask.ts` reads exactly this string to drop the public legs.
    assert seeded["team"] == {"publicFallback": "off"}
    assert provision.facts["public_fallback"] == "off"
    # Nothing else moved: the two shelf arms differ in this and in nothing else.
    as_shipped = tenjin_arm.seeded_config(source, seeded["loop"]["port"])
    assert {**seeded, "team": as_shipped["team"]} == as_shipped


def test_the_next_phase_keeps_the_value_its_first_phase_ran_under(prepare_arm: PrepareArm) -> None:
    provision, roots, _ = prepare_arm({"id": "tenjin_natural", "provision": "tenjin", "producer": True, "public_fallback": "off"})
    consumer = tenjin_arm.start_phase(roots, provision, "consumer")
    assert consumer.stop_state["public_fallback"] == "off"
    written = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
    assert written["team"] == {"publicFallback": "off"}


def test_a_value_the_product_has_no_setting_for_is_refused(prepare_arm: PrepareArm) -> None:
    with pytest.raises(ProvisionError) as caught:
        prepare_arm({"id": "tenjin_seeded", "provision": "tenjin", "public_fallback": "false"})
    assert "public_fallback" in str(caught.value)


def test_the_seeded_secret_is_a_canary_everywhere_but_the_seeded_config(make_roots) -> None:
    roots = make_roots()
    (roots.data_dir / "config.json").write_text(json.dumps({"shelfBypassSecret": SECRET}), encoding="utf-8")
    exclude = (roots.data_dir / "config.json",)
    assert artifact.scan_sentinels(roots, canaries=(SECRET,), exclude=exclude).credential_exposures == 0
    (roots.repo / "notes.md").write_text(f"header {SECRET}\n", encoding="utf-8")
    transcript = roots.profile / "projects" / "p" / "root.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"text": SECRET}) + "\n", encoding="utf-8")
    (roots.output / "daemon.log").write_text(f"sent {SECRET}\n", encoding="utf-8")
    report = artifact.scan_sentinels(roots, canaries=(SECRET,), exclude=exclude)
    assert report.credential_exposures == 3
    assert report.reason == "sentinel:credential_exposure"


# The runner's provision flow, with the fake executor's launch and no container.
#
# A live spec resolves its fixture image before any root exists, so the image
# lookup is the one thing these cases stub; nothing else about the flow is faked.


@pytest.fixture
def live_arm(register_executor, live_gates: Any) -> None:
    register_executor(
        LIVE,
        ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
            prepare=tenjin_arm.prepare,
            stop=tenjin_arm.stop,
        ),
    )


@pytest.fixture
def seeded_manifest(tmp_path: Path, live_arm: None):
    manifest = support.synthetic_manifest(tmp_path, executor_name=LIVE, arms=("off", "tenjin_seeded"))
    manifest.data["arms"][1]["provision"] = "tenjin"
    return manifest


@pytest.fixture
def make_runtime(source: tenjin_arm.Source) -> Callable[..., runner.Runtime]:
    def build(**overrides: object) -> runner.Runtime:
        clock = support.FakeClock()
        base = {"clock": clock, "sleep": clock.sleep, "spawn": support.fake_spawn(), "settle_cap_s": 1.0, "publishable": False, "ci": False, "source": source}
        return runner.Runtime(**{**base, **overrides})  # type: ignore[arg-type]

    return build


def trial_of(manifest, arm: str) -> schedule.Trial:
    return next(trial for trial in schedule.expand(manifest) if trial.arm_id == arm)


def test_a_provisioned_trial_runs_between_prepare_and_stop_and_records_the_facts(
    seeded_manifest, make_runtime, run_dir: Path, entrypoint: Entrypoint
) -> None:
    seen: list[tuple[bool, bool]] = []

    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        # What the container's daemon reads was in place before the agent
        # started, and the container reports what it did with it.
        seen.append(((roots.data_dir / "config.json").is_file(), (roots.data_dir / "daemon.token").is_file()))
        entrypoint(roots)

    runtime = make_runtime(spawn=support.fake_spawn(before=before))
    record = runner.run_trial(seeded_manifest, trial_of(seeded_manifest, "tenjin_seeded"), run_dir, "sha256:schedule", runtime)
    records.validate(record)
    assert seen == [(True, True)]
    assert record["isolation"]["image"]["tag"] == support.IMAGE.tag
    assert record["outcome"] == "pass"
    isolation = record["isolation"]
    assert (isolation["publishable"], isolation["shelf_secret_present"], isolation["shelf_origin"]) == (False, True, "team-shelf.example")
    assert isolation["daemon_respawned"] is False
    assert record["delivery"]["classes"] == {"team": 0, "public": 0, "local": 0, "other": 0}
    assert SECRET not in json.dumps(record)


def test_the_off_arm_is_not_provisioned_and_still_carries_the_facts(seeded_manifest, make_runtime, run_dir: Path) -> None:
    record = runner.run_trial(seeded_manifest, trial_of(seeded_manifest, "off"), run_dir, "sha256:schedule", make_runtime())
    records.validate(record)
    assert not (run_dir / "trials" / record["trial_id"] / "data" / "config.json").exists()
    assert record["isolation"]["shelf_secret_present"] is False
    assert "daemon_respawned" not in record["isolation"]


def test_a_publishable_run_with_a_seeded_secret_is_refused_before_any_root_exists(
    seeded_manifest, make_runtime, run_dir: Path
) -> None:
    with pytest.raises(IsolationError) as caught:
        runner.run_trial(
            seeded_manifest,
            trial_of(seeded_manifest, "tenjin_seeded"),
            run_dir,
            "sha256:schedule",
            make_runtime(publishable=True, attestation=support.ATTESTED),
        )
    assert caught.value.code == "shelf_secret_publishable"
    assert not (run_dir / "trials").exists()


@pytest.fixture
def public_source(write_source: WriteSource) -> tenjin_arm.Source:
    """A source with no shelf secret, so a publishable run is on the table."""
    return tenjin_arm.load_source(write_source({"baseUrl": "https://team-shelf.example", "publicShelfUrl": "https://public.example"}))


def test_an_attestation_has_to_list_the_seeded_shelf_origin(
    seeded_manifest, make_runtime, run_dir: Path, public_source
) -> None:
    with pytest.raises(IsolationError) as caught:
        runner.run_trial(
            seeded_manifest,
            trial_of(seeded_manifest, "tenjin_seeded"),
            run_dir,
            "sha256:schedule",
            make_runtime(publishable=True, attestation=support.ATTESTED, source=public_source),
        )
    assert caught.value.code == "allowlist_gap"
    assert "team-shelf.example" in str(caught.value)


def test_a_wal_left_live_makes_the_attempt_invalid(seeded_manifest, make_runtime, run_dir: Path) -> None:
    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        # A store the daemon left with its write-ahead log still beside it.
        support.write_loop_db(roots.data_dir / "loop.db", [])
        (roots.data_dir / "loop.db-wal").write_bytes(b"wal")

    with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
        record = runner.run_trial(
            seeded_manifest, trial_of(seeded_manifest, "tenjin_seeded"), run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=before))
        )
    assert (record["outcome"], record["invalid_reason"]) == ("invalid", "delivery:wal_live")


def legs(*shelves: str | tuple[str, str, str]) -> support.Before:
    """Legs on one prompt fire: a shelf name, or (shelf, status, outcome)."""

    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        db = roots.data_dir / "loop.db"
        support.write_loop_db(db, [("fire-1", launch.root_session_id, "")])
        connection = sqlite3.connect(db)
        for stage, leg in enumerate(shelves, start=1):
            shelf, status, outcome = (leg, "ok", "hit") if isinstance(leg, str) else leg
            connection.execute(
                "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-1', ?, ?, ?, ?, 5)", (stage, shelf, status, outcome)
            )
        connection.commit()
        connection.close()

    return before


def test_team_and_public_fallback_legs_are_named_and_an_unnamed_shelf_is_counted_without_invalidating(
    seeded_manifest, make_runtime, run_dir: Path, public_source
) -> None:
    trial = trial_of(seeded_manifest, "tenjin_seeded")
    # A team miss that fell back to the public marketplace: two named legs.
    record = runner.run_trial(
        seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=legs("team", "public")), source=public_source)
    )
    assert record["delivery"]["classes"] == {"team": 1, "public": 1, "local": 0, "other": 0}
    assert record["outcome"] == "pass"
    # A leg to a shelf this package cannot name is counted as `other`. It is
    # the daemon's own ledger, not an observation of the network, so it is
    # reported and the attempt still stands.
    record = runner.run_trial(
        seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=legs("team", "mirror")), source=public_source)
    )
    assert record["delivery"]["shelves"] == {"team": 1, "public": 0, "keys": 0, "local": 0, "other": 1}
    assert record["delivery"]["classes"] == {"team": 1, "public": 0, "local": 0, "other": 1}
    assert (record["outcome"], record["invalid_reason"]) == ("pass", None)


def test_keys_and_local_legs_are_classified_and_never_invalidate(
    seeded_manifest, make_runtime, run_dir: Path, public_source
) -> None:
    # What the second hooks smoke recorded per seeded attempt: the prompt
    # fire's team miss and public timeout, then two tool-failure fires
    # each sending a keys leg and a local leg. Every one of them is inside
    # the seeded config's reachable set, so none is a public request.
    trial = trial_of(seeded_manifest, "tenjin_seeded")
    before = legs(
        ("team", "ok", "miss"),
        ("public", "timeout", "no-answer"),
        ("keys", "ok", "miss"),
        ("local", "ok", "miss"),
        ("keys", "ok", "hit"),
        ("local", "ok", "miss"),
    )
    record = runner.run_trial(
        seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=before), source=public_source)
    )
    assert record["outcome"] == "pass"
    assert record["delivery"]["shelves"] == {"team": 1, "public": 1, "keys": 2, "local": 2, "other": 0}
    assert record["delivery"]["classes"] == {"team": 1, "public": 3, "local": 2, "other": 0}
    assert record["delivery"]["public"] == {"legs": 3, "hits": 1, "timeouts": 1, "no_answer": 1}
    # The leg's own status and outcome travel with it.
    assert ("public", "timeout", "no-answer") in [(leg["shelf"], leg["status"], leg["outcome"]) for leg in record["delivery"]["legs"]]
    # A publishable run has to list both named origins beside the provider.
    listed = type(support.ATTESTED)(**{**support.ATTESTED.__dict__, "network_allowlist": ("api.provider.example", "team-shelf.example")})
    with pytest.raises(IsolationError) as caught:
        runner.run_trial(seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(source=public_source, publishable=True, attestation=listed))
    assert "public.example" in str(caught.value)


@pytest.fixture
def cli_environ() -> dict[str, str]:
    return {"CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token"}


def test_ci_live_refuses_a_manifest_that_provisions_an_arm(write_source: WriteSource, run_dir: Path, cli_environ: dict) -> None:
    source = write_source()
    with pytest.raises(cli.CliError) as caught:
        cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, None, plumbing=True, ci_live=True, environ={"CI": "1", **cli_environ}, tenjin_source=source)
    assert "--ci-live" in str(caught.value)
    assert not run_dir.exists()
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr), mock.patch.dict(os.environ, {"CI": "1", **cli_environ}):
        code = cli.main(["live-run", "--manifest", str(cli.HOOKS_SMOKE_MANIFEST), "--out", str(run_dir), "--plumbing", "--ci-live", "--tenjin-source", str(source)])
    assert code == 2
    assert "smoke-only" in stderr.getvalue()


def test_a_provisioned_manifest_needs_a_source_and_a_secret_source_refuses_an_attestation(
    write_source: WriteSource, run_dir: Path, tmp_path: Path, cli_environ: dict
) -> None:
    source = write_source()
    with pytest.raises(cli.CliError) as caught:
        cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, None, plumbing=True, environ=cli_environ)
    assert "--tenjin-source" in str(caught.value)
    attestation = tmp_path / "attestation.json"
    attestation.write_text("{}", encoding="utf-8")
    with pytest.raises(cli.CliError) as caught:
        cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, attestation, environ=cli_environ, tenjin_source=source)
    assert "never publishable" in str(caught.value)
    with pytest.raises(cli.CliError) as caught:
        cli.live_run(run_dir, cli.SMOKE_MANIFEST, None, plumbing=True, environ=cli_environ, tenjin_source=source)
    assert "no provisioned arm" in str(caught.value).replace("has none", "no provisioned arm")


def test_the_dry_run_resolves_the_hooks_and_prints_no_token_and_no_secret(write_source: WriteSource, run_dir: Path) -> None:
    stream = io.StringIO()
    # A dry run arms the caller identity in the environment it is given, and the
    # container environment is built from the process environment, so this is the
    # one a real `live-run` arms; `patch.dict` puts it back.
    with mock.patch.dict(os.environ), mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        payload = cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=stream, environ=os.environ, tenjin_source=write_source())
    printed = stream.getvalue()
    installed = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)
    trials = schedule.expand(installed)
    handlers = [
        handler
        for arm in installed.arms
        if arm["id"] == "tenjin_seeded"
        for entries in arm["settings"]["hooks"].values()
        for entry in entries
        for handler in entry["hooks"]
    ]
    assert len(payload["trials"]) == len(trials)
    seeded = [plan for plan in payload["trials"] if plan["arm_id"] == "tenjin_seeded"]
    assert len(seeded) == len([trial for trial in trials if trial.arm_id == "tenjin_seeded"])
    for plan in seeded:
        assert plan["provision"]["shelf_secret_present"] is True
        # One resolved line per installed handler: the whole set, never a subset.
        assert len(plan["hooks"]) == len(handlers)
        assert any(hook.startswith(f"SubagentStart http http://127.0.0.1:{tenjin_arm.DAEMON_PORT}/hook/claude headers=Authorization") for hook in plan["hooks"])
        assert any("tenjin-shim.mjs" in hook and hook.startswith("SessionStart command") for hook in plan["hooks"])
    assert "shelf_secret_present=true shelf_origin=team-shelf.example" in printed
    # The image, the mount plan and the allowlist are printed, and nothing
    # was built, copied or started.
    assert "image     bench2-actor by stem" in printed
    assert "container bench2-" in printed
    assert "project   bench2-" in printed
    # What the line says, and what it deliberately does not: the sidecar drops
    # anything off the list, and reports no denial for the record to count.
    assert "allowlist api.anthropic.com public.example team-shelf.example; the sidecar drops anything else, and reports no denial" in printed
    for plan in payload["trials"]:
        assert plan["container"]["image"]["resolved"] is False
        assert [mount["mode"] for mount in plan["container"]["mounts"]] == ["rw"] * 5 + ["ro"]
        assert not (Path(plan["roots"]["cwd"]) / "node_modules" / "vitest").exists()
    assert SECRET not in printed
    assert tenjin_arm.DRY_TOKEN not in printed
    for plan in payload["trials"]:
        if plan["arm_id"] == "off":
            assert plan["hooks"] == []
            assert plan["provision"] is None


def test_the_dry_run_needs_no_source(run_dir: Path) -> None:
    with mock.patch.dict(os.environ):
        payload = cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=io.StringIO(), environ=os.environ)
    seeded = next(plan for plan in payload["trials"] if plan["arm_id"] == "tenjin_seeded")
    assert seeded["provision"]["shelf_secret_present"] is False


def test_a_report_that_carries_the_seeded_secret_is_deleted(run_dir: Path) -> None:
    run_dir.mkdir(parents=True)
    (run_dir / "report.json").write_text(json.dumps({"x": SECRET}), encoding="utf-8")
    with pytest.raises(cli.CliError):
        cli.refuse_secret_in_report(run_dir, (SECRET,))
    assert not (run_dir / "report.json").exists()
    (run_dir / "report.json").write_text("{}", encoding="utf-8")
    cli.refuse_secret_in_report(run_dir, (SECRET,))
    assert (run_dir / "report.json").exists()


# The lesson seed on a fake CLI: keyed publish at prepare, the shortlist and the delete at stop, every outcome in the facts.


PROBE_LINE = "Error: ENOENT: no such file or directory, open 'settings.json'"
PROBE_KEY = signature.sig_v1(PROBE_LINE, PROBE_LINE + "\n    at load (/tmp/x/src/load.mjs:3:9)")


@pytest.fixture
def lessons(tmp_path: Path) -> Path:
    path = tmp_path / "lessons"
    path.mkdir()
    return path


def write_lesson(lessons: Path, key: str | None) -> None:
    (lessons / "fam.json").write_text(
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


def write_fix_lesson(lessons: Path) -> str:
    """The task's own fix, keyed on the test identity vitest's FAIL header names."""
    key = signature.sig_v1_test(signature.TestIdentity(file="tests/probe.test.mjs", suite="probeKey", test="case 1"))
    (lessons / "probe-fix.md").write_text("# The fix\n\nDefault the agent.\n", encoding="utf-8")
    (lessons / "probe-fix.json").write_text(
        json.dumps({"id": "probe-fix", "title": "The fix", "commands": [{"command": "node assertion-{task}.mjs", "kind": "sig_v1_test", "key": key, "check": True, "reason": "header"}]}),
        encoding="utf-8",
    )
    return key


def host_probe(image: str, probe: Path, command: str, environment: dict[str, str]) -> subprocess.CompletedProcess:
    """The probe seam, running the command where this suite can: on the host, in the scratch copy."""
    return subprocess.run(command.split(" "), cwd=probe, env=environment, capture_output=True, text=True, shell=False, check=False)


@pytest.fixture
def seed_lane(lessons: Path) -> Iterator[None]:
    """The lesson directory, the probe seam, and every `tenjin` invocation replaced by the fake CLI."""
    assert PROBE_KEY is not None
    (lessons / "fam.md").write_text("# The lesson\n\nRun the one file.\n", encoding="utf-8")
    write_lesson(lessons, PROBE_KEY)
    patches = [
        mock.patch.object(tenjin_arm, "PROBE_RUN", host_probe),
        mock.patch.object(tenjin_arm, "PUBLISH_ARGV", lambda body, keys: [sys.executable, FAKE_CLI, *tenjin_arm.publish_argv(body, keys)[1:]]),
        mock.patch.object(tenjin_arm, "DELETE_ARGV", lambda piece: [sys.executable, FAKE_CLI, *tenjin_arm.delete_argv(piece)[1:]]),
        mock.patch.object(tenjin_arm, "SEARCH_ARGV", lambda query: [sys.executable, FAKE_CLI, *tenjin_arm.search_argv(query)[1:]]),
        mock.patch.object(tenjin_arm, "LESSONS", lessons),
    ]
    for patch in patches:
        patch.start()
    yield
    for patch in patches:
        patch.stop()


@pytest.fixture
def seed_roots(tmp_path: Path, run_dir: Path) -> artifact.TrialRoots:
    fixture = tmp_path / "seed-fixture"
    fixture.mkdir(exist_ok=True)
    (fixture / "probe-probe.mjs").write_text(PROBE_MJS, encoding="utf-8")
    (fixture / "ok-probe.mjs").write_text("process.exit(0);\n", encoding="utf-8")
    (fixture / "assertion-probe.mjs").write_text(
        "console.log(' FAIL  tests/probe.test.mjs > probeKey > case 1');\nconsole.log(\"AssertionError: expected 's1:undefined' to be 's1:root' // Object.is equality\");\nprocess.exit(1);\n",
        encoding="utf-8",
    )
    return artifact.create(run_dir, "trial-seed", fixture)


def seed_environment(roots: artifact.TrialRoots) -> dict[str, str]:
    return {"PATH": os.environ.get("PATH", ""), "HOME": str(roots.home)}


@pytest.fixture
def seed_request(source: tenjin_arm.Source, seed_roots: artifact.TrialRoots, seed_lane: None) -> Callable[..., ProvisionRequest]:
    def build(nonce: str | None = "20260908T000000Z-0badf00d", *, from_source: tenjin_arm.Source | None = None, **overrides: object) -> ProvisionRequest:
        base = dict(task=TASK, environment=seed_environment(seed_roots), nonce=nonce, image=support.IMAGE.id)
        base.update(overrides)
        return ProvisionRequest(seed_roots.trial_id, seed_roots, {"id": "tenjin_seeded", "provision": "tenjin"}, source if from_source is None else from_source, **base)  # type: ignore[arg-type]

    return build


@pytest.fixture
def calls(source: tenjin_arm.Source) -> Callable[[], list[dict]]:
    def read() -> list[dict]:
        path = Path(source.path) / "cli-calls.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    return read


def test_the_probe_recipe_carries_what_the_image_entrypoint_needs_and_reaches_nothing(tmp_path: Path) -> None:
    """The entrypoint refuses without an output root, and a probe that reached anything would measure something else."""
    probe = tmp_path / "probe"
    output = tmp_path / "probe-output"
    recipe = tenjin_arm.probe_recipe("sha256:image", probe, {"HOME": str(tmp_path), container.OUTPUT_VAR: str(output)})
    assert recipe.environment[container.OUTPUT_VAR] == str(output)
    # Mounted as well as named: nothing outside a mount exists in there.
    assert [mount.host for mount in recipe.plan] == [probe, output]
    assert recipe.workdir == probe
    assert recipe.egress.mode == container.NO_NETWORK
    # No daemon: the probe runs the fixture's own commands, not an arm.
    assert recipe.daemon is False


def test_the_probe_gets_its_own_output_root_and_a_copy_that_keeps_its_symlinks(seed_roots, seed_lane: None) -> None:
    roots = seed_roots
    (roots.repo / "bin").mkdir()
    (roots.repo / "bin" / "runner").symlink_to(Path("..") / "probe-probe.mjs")
    seen: dict[str, object] = {}

    def run(image: str, probe: Path, command: str, environment: dict[str, str]) -> subprocess.CompletedProcess:
        link = probe / "bin" / "runner"
        seen.update(output=environment[container.OUTPUT_VAR], symlink=link.is_symlink(), target=str(link.resolve()))
        return subprocess.run(["node", str(link)], cwd=probe, env=environment, capture_output=True, text=True, shell=False, check=False)

    with mock.patch.object(tenjin_arm, "PROBE_RUN", run):
        probed = tenjin_arm.probe_keys(roots, ["node probe-probe.mjs"], seed_environment(roots), support.IMAGE.id)
    # The probe's own output root, never the attempt's.
    assert seen["output"] == str(roots.base / tenjin_arm.PROBE_OUTPUT_DIR)
    assert seen["output"] != str(roots.output)
    # A dereferenced copy puts every relative link's target somewhere else,
    # which is how a pnpm `.bin` shim stops finding its own entry point.
    assert seen["symlink"]
    assert seen["target"] == str((roots.base / tenjin_arm.PROBE_DIR / "probe-probe.mjs").resolve())
    assert probed["node probe-probe.mjs"]["sig_v1"] == PROBE_KEY
    # Both scratch roots leave with the probe.
    assert not (roots.base / tenjin_arm.PROBE_DIR).exists()
    assert not (roots.base / tenjin_arm.PROBE_OUTPUT_DIR).exists()


def test_prepare_probes_publishes_with_the_key_and_stop_deletes(seed_roots, seed_request, calls) -> None:
    provision = tenjin_arm.prepare(seed_request())
    (seed,) = provision.facts["seed"]
    assert (seed["lesson"], seed["piece_id"], seed["published"], seed["keys"], seed["deleted"]) == ("fam", "piece-1", True, 1, None)
    assert seed["key_hashes"] == [tenjin_arm.key_hash(f"sig_v1:{PROBE_KEY}")]
    assert seed["probe"] == {"node probe-probe.mjs": tenjin_arm.key_hash(f"sig_v1:{PROBE_KEY}"), "node ok-probe.mjs": None}
    assert PROBE_KEY not in json.dumps(seed)
    assert not (seed_roots.base / "probe").exists()
    publish = calls()[0]
    assert publish["argv"][:1] + publish["argv"][2:] == ["publish", "--yes", "--json", "--key", f"fingerprint=sig_v1:{PROBE_KEY}"]
    body = Path(publish["argv"][1])
    assert body.is_relative_to(seed_roots.base) and not body.is_relative_to(seed_roots.repo)
    assert f"Benchmark seed: run 20260908T000000Z-0badf00d trial {seed_roots.trial_id}." in body.read_text(encoding="utf-8")
    assert seed["nonce"] == "20260908T000000Z-0badf00d"
    assert "TENJIN_DATA_DIR" in publish["env"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in publish["env"]
    report = tenjin_arm.stop(seed_roots, provision)
    assert report["seed_deleted"] == {"piece-1": None}
    assert calls()[1]["argv"] == ["delete", "piece-1", "--yes", "--json"]
    assert runner.isolation_of({"live": True}, provision, report)["seed"][0]["deleted"] is True


def test_a_task_with_a_fix_lesson_seeds_two_pieces_under_two_kinds_and_stop_deletes_both(
    lessons: Path, seed_roots, seed_request, calls, family_session
) -> None:
    fix_key = write_fix_lesson(lessons)
    provision = tenjin_arm.prepare(seed_request())
    seeds = provision.facts["seed"]
    assert [(seed["lesson"], seed["piece_id"], seed["keys"]) for seed in seeds] == [("fam", "piece-1", 1), ("probe-fix", "piece-2", 1)]
    assert seeds[1]["key_hashes"] == [tenjin_arm.key_hash(f"sig_v1_test:{fix_key}")]
    assert seeds[1]["probe"] == {"node assertion-probe.mjs": tenjin_arm.key_hash(f"sig_v1_test:{fix_key}")}
    publishes = [call["argv"] for call in calls() if call["argv"][0] == "publish"]
    assert publishes[1][2:] == ["--yes", "--json", "--key", f"fingerprint=sig_v1_test:{fix_key}"]
    report = tenjin_arm.stop(seed_roots, provision)
    assert report["seed_deleted"] == {"piece-1": None, "piece-2": None}
    isolation = runner.isolation_of({"live": True}, provision, report)
    assert [seed["deleted"] for seed in isolation["seed"]] == [True, True]
    record = support.attempt_record(family_session)
    records.validate({**record, "isolation": {**record["isolation"], "seed": isolation["seed"]}})


def test_a_second_publish_that_fails_deletes_the_first(lessons: Path, source, seed_request, calls) -> None:
    write_fix_lesson(lessons)
    (Path(source.path) / "fail-second-publish").write_text("", encoding="utf-8")
    with pytest.raises(ProvisionError):
        tenjin_arm.prepare(seed_request())
    argv = [call["argv"][:2] for call in calls()]
    assert argv[0][0] == "publish"
    assert argv[1][0] == "publish"
    assert argv[2] == ["delete", "piece-1"]


def test_a_delete_that_fails_is_a_fact_in_the_record(source, seed_roots, seed_request, family_session) -> None:
    provision = tenjin_arm.prepare(seed_request())
    (Path(source.path) / "fail-delete").write_text("", encoding="utf-8")
    report = tenjin_arm.stop(seed_roots, provision)
    assert "exited 4" in report["seed_deleted"]["piece-1"]
    isolation = runner.isolation_of({"live": True}, provision, report)
    assert (isolation["seed"][0]["deleted"], isolation["seed"][0]["piece_id"]) == (False, "piece-1")
    record = support.attempt_record(family_session)
    record["isolation"] = {**record["isolation"], "seed": isolation["seed"]}
    records.validate(record)
    with pytest.raises(records.RecordError):
        records.validate({**record, "isolation": {**record["isolation"], "seed": [{**isolation["seed"][0], "piece_id": None}]}})
    with pytest.raises(records.RecordError):
        records.validate({**record, "isolation": {**record["isolation"], "seed": isolation["seed"][0]}})


def test_the_seeding_publish_is_given_the_passphrase_that_opens_the_wallet(source, seed_request, calls) -> None:
    """End to end, because the gap was between the workflow's environment and the child's.

    The workflow set `TENJIN_WALLET_PASSPHRASE` for `live-run` and
    `cli_environment` did not forward it, so every seeded attempt of run
    34394026777 was refused at `provision:seed_publish`. The fake CLI logs
    the names in its environment; the passphrase's presence there is what
    a real `tenjin publish` needs to sign.
    """
    with mock.patch.dict(os.environ, {tenjin_arm.WALLET_PASSPHRASE: PASSPHRASE}):
        with_passphrase = tenjin_arm.load_source(Path(source.path))
    tenjin_arm.prepare(seed_request(from_source=with_passphrase))
    publish = next(call for call in calls() if call["argv"][0] == "publish")
    assert tenjin_arm.WALLET_PASSPHRASE in publish["env"]


def test_key_drift_and_a_failed_publish_refuse_the_trial_before_the_daemon_and_mask_the_secret(
    lessons: Path, source, seed_roots, seed_request, calls
) -> None:
    request = seed_request()
    write_lesson(lessons, "0000000000000000")
    with pytest.raises(ProvisionError) as caught:
        tenjin_arm.prepare(request)
    assert "seed key drift" in str(caught.value)
    assert calls() == []
    write_lesson(lessons, PROBE_KEY)
    (Path(source.path) / "fail-publish").write_text("", encoding="utf-8")
    with pytest.raises(ProvisionError) as caught:
        tenjin_arm.prepare(request)
    assert "tenjin publish exited 4" in str(caught.value)
    assert SECRET not in str(caught.value)
    assert "[secret]" in str(caught.value)


def test_an_envelope_on_stderr_is_read_by_shape(source, seed_request) -> None:
    (Path(source.path) / "envelope-on-stderr").write_text("", encoding="utf-8")
    provision = tenjin_arm.prepare(seed_request())
    assert provision.facts["seed"][0]["piece_id"] == "piece-1"
    assert tenjin_arm.envelope_of("", '{"ok":true,"data":{"post":{"id":"p-9"}}}') == {"ok": True, "data": {"post": {"id": "p-9"}}}
    assert tenjin_arm.piece_id_of({"ok": True, "data": {"post": {"id": "p-9"}}}) == "p-9"
    assert tenjin_arm.piece_id_of({"data": {"postId": "p-8"}}) == "p-8"
    assert tenjin_arm.envelope_of("Published x\n", "not json") is None
    assert tenjin_arm.piece_id_of({"ok": True, "data": {}}) is None


def test_a_publish_whose_id_cannot_be_read_sweeps_the_shelf_by_title_and_refuses(source, seed_roots, seed_request, calls) -> None:
    source_dir = Path(source.path)
    (source_dir / "garbage-publish").write_text("", encoding="utf-8")
    (source_dir / "search-results.json").write_text(
        json.dumps([{"resourceId": "stray-1", "title": "The lesson"}, {"resourceId": "theirs", "title": "Somebody else's piece"}, {"resourceId": "stray-2", "title": "The lesson"}]),
        encoding="utf-8",
    )
    with pytest.raises(ProvisionError) as caught:
        tenjin_arm.prepare(seed_request())
    assert "no piece id could be read" in str(caught.value)
    assert "2 matched, 2 deleted, 0 failed" in str(caught.value)
    argv = [call["argv"] for call in calls()]
    assert argv[1][:2] == ["search", "The lesson"]
    assert argv[2:] == [["delete", "stray-1", "--yes", "--json"], ["delete", "stray-2", "--yes", "--json"]]
    note = json.loads((seed_roots.output / tenjin_arm.SEED_NOTE).read_text(encoding="utf-8"))
    assert (note["published"], note["exit"], note["sweep"]["deleted"]) == ("unknown", 0, ["stray-1", "stray-2"])
    assert f"trial {seed_roots.trial_id}" in note["stamp"]


def test_a_dedup_answer_is_a_refusal_and_two_runs_stamp_differently(source, seed_roots, seed_request, calls) -> None:
    (Path(source.path) / "already-published").write_text("", encoding="utf-8")
    with pytest.raises(ProvisionError) as caught:
        tenjin_arm.prepare(seed_request())
    assert "the CLI's publish dedup matched a body this machine already published; the stamp must be unique per run" in str(caught.value)
    note = json.loads((seed_roots.output / tenjin_arm.SEED_NOTE).read_text(encoding="utf-8"))
    assert (note["published"], note["already_published_url"]) == (False, "https://team-shelf.example/a/ali/the-lesson")
    assert [call["argv"][0] for call in calls()] == ["publish"]
    with pytest.raises(ProvisionError) as missing:
        tenjin_arm.prepare(seed_request(nonce=None))
    assert "run nonce" in str(missing.value)
    lesson = tenjin_arm.lesson_named("fam")
    assert lesson is not None
    first = tenjin_arm.seed_body(lesson, seed_roots, "20260908T000000Z-0badf00d", seed_roots.trial_id).read_text(encoding="utf-8")
    second = tenjin_arm.seed_body(lesson, seed_roots, "20260908T000100Z-deadbeef", seed_roots.trial_id).read_text(encoding="utf-8")
    assert first != second
    assert first.split("Benchmark seed")[0] == second.split("Benchmark seed")[0]


def test_the_run_nonce_is_minted_once_and_reused_on_resume(tmp_path: Path) -> None:
    manifest = support.synthetic_manifest(tmp_path)
    out = tmp_path / "run-a"
    first = cli.run_nonce(out, manifest)
    assert re.match(cli.NONCE, first)
    assert cli.run_nonce(out, manifest) == first
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8"))["nonce"] == first
    assert cli.run_nonce(tmp_path / "run-b", manifest) != first


def test_a_dry_run_states_the_seed_and_publishes_nothing(seed_request, calls) -> None:
    request = seed_request(nonce=None, dry_run=True, environment=None)
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        provision = tenjin_arm.prepare(request)
    (seed,) = provision.facts["seed"]
    assert (seed["published"], seed["piece_id"], seed["probe"], seed["key_hashes"]) == (False, None, None, [tenjin_arm.key_hash(f"sig_v1:{PROBE_KEY}")])
    assert calls() == []


def test_a_task_without_a_lesson_seeds_nothing(seed_request, calls) -> None:
    provision = tenjin_arm.prepare(seed_request(task={"id": "x", "family": "smoke"}))
    assert "seed" not in provision.facts
    assert calls() == []


def test_an_arm_may_name_exactly_the_lessons_it_seeds(lessons: Path, seed_roots, seed_request) -> None:
    write_fix_lesson(lessons)
    request = seed_request()
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
    assert [seed["lesson"] for seed in provision.facts["seed"]] == ["probe-fix"]
    assert sorted(path.name for path in (seed_roots.data_dir / "hooks").iterdir()) == sorted(tenjin_arm.BUNDLES)
    assert "tenjin-vitest-reporter.mjs" in tenjin_arm.BUNDLES
    with pytest.raises(ProvisionError):
        tenjin_arm.lessons_for(TASK, selected=["absent"])


def actor_failure_key() -> str:
    """The `sig_v1_test` key the actor fixture's own failing case yields.

    Unfixed, `actorKey` interpolates a missing agent, so the hidden case
    that passes no agent is the one vitest names in its FAIL header. The
    file, the title template and the case index all come off the fixture,
    and the product's own console rule turns the header into the key, so a
    regenerated fixture moves the lesson and this expectation together.
    """
    test_file = tenjin_arm.FIXTURES / "live" / "actor" / "tests" / "actor.test.mjs"
    template = re.search(r"test\.each\(cases\)\('([^']+)'", test_file.read_text(encoding="utf-8"))
    hidden = json.loads((verifier.HIDDEN / "actor" / "cases.json").read_text(encoding="utf-8"))
    assert template is not None
    index = next(position for position, case in enumerate(hidden) if len(case["args"]) == 1)
    identity = signature.identity_from_console(f" FAIL  tests/{test_file.name} > {template.group(1).replace('%#', str(index))}")
    assert identity is not None
    return f"sig_v1_test:{signature.sig_v1_test(identity)}"


def test_the_key_only_lesson_shares_no_file_name_with_the_prompt() -> None:
    live = tenjin_arm.FIXTURES / "live" / "lessons"
    lesson = tenjin_arm.lesson_named("actor-fix-keyonly", live)
    assert lesson is not None
    prompt = next(task for task in json.loads(cli.KEYS_SMOKE_MANIFEST.read_text(encoding="utf-8"))["tasks"])["prompt"]
    text = lesson.title + "\n" + lesson.body.read_text(encoding="utf-8")
    assert cases.shared_file_names(prompt, text) == []
    for word in ("actor", "actorKey", "src/actor.mjs", "tests/actor.test.mjs"):
        assert word.lower() not in text.lower()
    assert lesson.keys == (actor_failure_key(),)
    assert cases.shared_file_names(prompt, "edit src/actor.mjs") == ["actor", "actor.mjs"]


def test_the_live_lesson_is_loadable_and_its_keys_are_the_fixture_failures() -> None:
    live = tenjin_arm.FIXTURES / "live" / "lessons"
    lessons = tenjin_arm.lessons_for({"id": "actor", "family": "test-harness-convention"}, live)
    assert [lesson.id for lesson in lessons] == ["test-harness-convention", "actor-fix"]
    convention, fix = lessons
    assert convention.keys == ("sig_v1:ee9fd96defcffbeb",)
    assert [entry.command for entry in convention.commands if entry.check and entry.key is None] == ["pnpm test -- tests/{task}.test.mjs"]
    assert "pnpm exec vitest run" in convention.body.read_text(encoding="utf-8")
    # The fix lesson carries the key run seven's fires table recorded for this failure.
    assert fix.keys == (actor_failure_key(),)
    assert tenjin_arm.key_hash("sig_v1:ee9fd96defcffbeb") == "ed094b3427f6e7e2"
    assert "s9" not in fix.body.read_text(encoding="utf-8")
    assert tenjin_arm.lessons_for({"id": "answer-file", "family": "smoke"}, live) == []


def write_ledger(roots: artifact.TrialRoots, rows: list[tuple[str, str, str, str | None, str | None]]) -> None:
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


def read_shortlist(roots: artifact.TrialRoots) -> dict:
    return json.loads((roots.output / tenjin_arm.SHORTLIST_FILE).read_text(encoding="utf-8"))


@pytest.fixture
def shelf(source: tenjin_arm.Source) -> Callable[..., None]:
    def write(*items: dict) -> None:
        (Path(source.path) / "search-items.json").write_text(json.dumps(list(items)), encoding="utf-8")

    return write


def test_the_shortlist_is_taken_before_the_delete_and_names_the_live_seeded_ids(source, seed_roots, seed_request, calls, shelf) -> None:
    provision = tenjin_arm.prepare(seed_request())
    write_ledger(
        seed_roots,
        [
            ("f1", "prompt", "prompt", QUESTION, None),
            ("f2", "prompt", "prompt", QUESTION, None),
            ("f3", "failure", "tool.after", "Why does the actor test fail?", "502b90852a1505e3"),
            ("f4", "failure", "tool.after", None, "502b90852a1505e3"),
        ],
    )
    shelf(
        {"resourceId": "piece-1", "title": "The lesson", "url": "https://team-shelf.example/p/piece-1", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1"},
        {"resourceId": "piece-real", "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False},
    )
    report = tenjin_arm.stop(seed_roots, provision)
    assert report["shortlist"] == {"written": True, "questions": 2, "failed": 0, "error": None}
    assert report["seed_deleted"] == {"piece-1": None}
    payload = read_shortlist(seed_roots)
    assert (payload["trial_id"], payload["seeded_piece_ids"], payload["limit"]) == (seed_roots.trial_id, ["piece-1"], 10)
    assert payload["shelf_origin"] == "team-shelf.example"
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", payload["at"])
    # One entry per distinct question and key, in fire order; the key-only fire is not a search.
    assert [(entry["question"], entry["question_key"], entry["fire_id"], entry["fire_event"], entry["hook_arm"]) for entry in payload["entries"]] == [
        (QUESTION, None, "f1", "prompt", "prompt"),
        ("Why does the actor test fail?", "502b90852a1505e3", "f3", "tool.after", "failure"),
    ]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", payload["entries"][0]["at"])
    search = payload["entries"][0]["search"]
    assert (search["exit"], search["error"], search["post_floor"], search["limit"], search["search_id"]) == (0, None, True, 10, "search-1")
    # The seeded piece is in the shortlist, which it can only be while it is still on the shelf.
    assert [(c["rank"], c["id"], c["title"], c["strong"], c["confidence"], c["corroborated"]) for c in search["candidates"]] == snapshot(
        [
            (1, "piece-1", "The lesson", True, 0.9, True),
            (2, "piece-real", "The convention piece", False, None, None),
        ]
    )
    argv = [call["argv"] for call in calls()]
    assert [call[0] for call in argv] == ["publish", "search", "search", "delete"]
    assert argv[1] == ["search", QUESTION, "--json", "--limit", "10"]
    # And after the delete it is gone, which is the whole reason the snapshot exists.
    assert tenjin_arm.search_shortlist(source, QUESTION)["candidates"][0]["id"] == "piece-real"


def test_a_search_that_fails_is_recorded_for_that_question_and_the_trial_still_stops(source, seed_roots, seed_request) -> None:
    provision = tenjin_arm.prepare(seed_request())
    write_ledger(seed_roots, [("f1", "prompt", "prompt", QUESTION, None)])
    (Path(source.path) / "fail-search").write_text("", encoding="utf-8")
    report = tenjin_arm.stop(seed_roots, provision)
    assert report["shortlist"] == {"written": True, "questions": 1, "failed": 1, "error": None}
    assert report["seed_deleted"] == {"piece-1": None}
    search = read_shortlist(seed_roots)["entries"][0]["search"]
    assert (search["exit"], search["candidates"]) == (4, [])
    assert "search refused: 502" in search["error"]


def test_a_trial_with_no_ledger_writes_an_empty_shortlist_and_an_unreadable_one_is_not_fatal(seed_roots, seed_request) -> None:
    provision = tenjin_arm.prepare(seed_request())
    report = tenjin_arm.stop(seed_roots, provision)
    assert (report["shortlist"]["written"], report["shortlist"]["questions"]) == (True, 0)
    assert read_shortlist(seed_roots)["entries"] == []
    assert report["seed_deleted"] == {"piece-1": None}
    seed_roots.data_dir.joinpath(tenjin_arm.LOOP_DB).write_bytes(b"not a database")
    report = tenjin_arm.stop(seed_roots, provision)
    assert not report["shortlist"]["written"]
    assert "DatabaseError" in report["shortlist"]["error"]
    assert report["seed_deleted"] == {"piece-1": None}


def test_the_shortlist_masks_the_shelf_secret(seed_roots, seed_request, shelf) -> None:
    provision = tenjin_arm.prepare(seed_request())
    write_ledger(seed_roots, [("f1", "prompt", "prompt", QUESTION, None)])
    shelf({"resourceId": "piece-1", "title": f"The lesson {SECRET}", "url": "https://team-shelf.example/p/piece-1", "strong": True})
    tenjin_arm.stop(seed_roots, provision)
    text = (seed_roots.output / tenjin_arm.SHORTLIST_FILE).read_text(encoding="utf-8")
    assert SECRET not in text
    assert "[secret]" in text


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


# The natural arm: a verified producer session on the same store, then the consumer on a fresh copy.
#
# The daemon a phase runs is the container's. These cases stand in for that
# container: they start `tests/fake_daemon.py` on the mounted data dir for the
# length of the attempt, post the phase's hook events to it, stop it, and leave
# the `daemon.json` the entrypoint would leave.


@pytest.fixture
def start_daemon() -> Iterator[Callable[[artifact.TrialRoots], tuple[subprocess.Popen, str, str]]]:
    running: list[subprocess.Popen] = []

    def start(roots: artifact.TrialRoots) -> tuple[subprocess.Popen, str, str]:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(roots.home), "TENJIN_DATA_DIR": os.path.abspath(roots.data_dir)}
        process = subprocess.Popen(FAKE_DAEMON, cwd=roots.data_dir, env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        running.append(process)
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

    yield start
    for process in running:
        if process.poll() is None:
            process.kill()


def stop_daemon(roots: artifact.TrialRoots, process: subprocess.Popen) -> None:
    process.terminate()
    process.wait(timeout=10)
    roots.output.mkdir(parents=True, exist_ok=True)
    (roots.output / tenjin_arm.DAEMON_REPORT).write_text(
        json.dumps({"requested": True, "started": True, "pid": process.pid, "respawned": False, "wal_live": False}) + "\n", encoding="utf-8"
    )


@pytest.fixture
def natural_manifest(tmp_path: Path, live_arm: None):
    manifest = support.synthetic_manifest(tmp_path, executor_name=LIVE, arms=("off", "tenjin_natural"))
    manifest.data["arms"][1].update({"provision": "tenjin", "producer": True})
    return manifest


@pytest.fixture
def producer_spawn(start_daemon) -> Callable[..., runner.Spawn]:
    def build(*, fix: bool = True, capture: bool = True) -> runner.Spawn:
        daemon: list[subprocess.Popen] = []

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            if roots.phase != "producer":
                return
            process, url, token = start_daemon(roots)
            daemon.append(process)
            if capture:
                _failure_then_fix(url, token, launch.root_session_id, str(launch.cwd), "node assertion-x.mjs", " FAIL  tests/x.test.mjs > x > case 1\nAssertionError: expected 1 to be 2\n", f"{launch.cwd}/src/x.mjs")
                _post(url, token, {"session_id": launch.root_session_id, "cwd": str(launch.cwd), "transcript_path": "t", "hook_event_name": "Stop", "stop_hook_active": False})

        def after(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            if roots.phase != "producer":
                return
            stop_daemon(roots, daemon[-1])
            if not fix:
                (roots.repo / "answer.txt").write_text("41\n", encoding="utf-8")
            # The fake executor reuses request ids per session; a real harness mints unique ones.
            for path in (roots.output / "sessions").rglob("*.jsonl"):
                path.write_text(path.read_text(encoding="utf-8").replace('"req_', '"producer_req_'), encoding="utf-8")

        return support.fake_spawn(before=before, after=after)

    return build


def test_the_producer_runs_first_is_verified_and_its_capture_reaches_the_consumer(
    natural_manifest, make_runtime, producer_spawn, run_dir: Path
) -> None:
    spawns: list[str | None] = []
    base = producer_spawn()

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        spawns.append(roots.phase)
        return base(launch, roots, timeout_s)

    record = runner.run_trial(natural_manifest, trial_of(natural_manifest, "tenjin_natural"), run_dir, "sha256:schedule", make_runtime(spawn=spawn))
    records.validate(record)
    assert spawns == ["producer", None]
    assert record["outcome"] == "pass"
    produced = record["isolation"]["producer"]
    assert (produced["outcome"], produced["daemon"], produced["wal_live_between_phases"], produced["stop_reason"]) == ("pass", "restarted", False, "exit")
    assert produced["verifier"] == {"id": "fake_answer_file", "exit_code": 0}
    assert produced["capture"]["pairings"] == {"open": 0, "unverified": 1, "verified": 0}
    assert (produced["capture"]["turn_end_fires"], produced["capture"]["fires"]) == (1, 2)
    assert produced["usage_reconciliation"] == {"status": "matched"}
    assert produced["tokens"]["input_total"] > 0
    assert produced["phase_tokens"]["capture"] == 0
    assert {receipt["component"] for receipt in record["auxiliary"]} == {"producer"}
    assert {receipt["phase"] for receipt in record["auxiliary"]} == {"producer"}
    assert sum(receipt["input_total"] + receipt["output_total"] for receipt in record["auxiliary"]) == produced["tokens"]["input_total"] + produced["tokens"]["output_total"]
    assert record["delivery"]["phase_fires"] == {produced["native_root_id"]: 2}
    assert record["delivery"]["unmatched_fires"] == []
    assert produced["native_root_id"] != record["native_root_id"]
    # Producer roots beside the consumer's, on the shared data dir; the consumer's repository was fresh.
    trial_dir = run_dir / "trials" / record["trial_id"]
    assert (trial_dir / "producer" / "output" / "sessions").is_dir()
    assert (trial_dir / "producer" / "verify").is_dir()
    assert SECRET not in json.dumps(record)


def test_a_producer_that_does_not_fix_the_task_makes_the_attempt_invalid_and_starts_no_consumer(
    natural_manifest, make_runtime, producer_spawn, run_dir: Path
) -> None:
    spawns: list[str | None] = []
    base = producer_spawn(fix=False)

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        spawns.append(roots.phase)
        return base(launch, roots, timeout_s)

    record = runner.run_trial(natural_manifest, trial_of(natural_manifest, "tenjin_natural"), run_dir, "sha256:schedule", make_runtime(spawn=spawn))
    records.validate(record)
    assert spawns == ["producer"]
    assert (record["outcome"], record["invalid_reason"]) == ("invalid", "producer:failed")
    assert record["isolation"]["producer"]["outcome"] == "invalid"
    assert record["isolation"]["producer"]["verifier"]["exit_code"] == 1


def test_a_producer_that_captured_nothing_is_a_valid_natural_attempt(
    natural_manifest, make_runtime, producer_spawn, run_dir: Path
) -> None:
    record = runner.run_trial(
        natural_manifest, trial_of(natural_manifest, "tenjin_natural"), run_dir, "sha256:schedule", make_runtime(spawn=producer_spawn(capture=False))
    )
    records.validate(record)
    assert record["outcome"] == "pass"
    assert record["isolation"]["producer"]["capture"]["pairings"] == {"open": 0, "unverified": 0, "verified": 0}
    assert record["delivery"].get("phase_fires") == {}


def test_producer_requests_from_the_first_turn_end_on_are_capture_cost(tmp_path: Path) -> None:
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
    assert [(receipt.native_request_id, receipt.phase) for receipt in receipts] == [("a", "producer"), ("b", "capture"), ("c", "capture"), ("d", "producer")]
    assert producer.phase_tokens(receipts) == {"producer": 30, "capture": 30}
    assert {receipt.phase for receipt in producer.receipts_of("t", [record("a")], times, None)} == {"producer"}
    transcript = tmp_path / "root.jsonl"
    transcript.write_text('{"requestId": "r1", "timestamp": "2026-09-08T00:00:01.500Z"}\n{"requestId": "r1", "timestamp": "2026-09-08T00:00:09Z"}\nnot json\n{"requestId": "r2"}\n', encoding="utf-8")
    assert producer.request_times(transcript) == {"r1": 1788825601500}


def test_a_config_without_a_public_shelf_url_still_allowlists_the_product_default() -> None:
    """Silence in the config is not silence on the wire.

    The product falls back to its production origin, so an allowlist built
    from the config alone refused the public leg and the refusal threw the
    trial away as a public request.
    """
    source = tenjin_arm.Source(path=Path("."), config={"baseUrl": "https://shelf.example"}, bundles={})
    assert source.public_origin == "tenjin.blog"
    assert source.origins == ("shelf.example", "tenjin.blog")


def test_a_named_public_shelf_url_wins() -> None:
    source = tenjin_arm.Source(
        path=Path("."),
        config={"baseUrl": "https://shelf.example", "publicShelfUrl": "https://public.example"},
        bundles={},
    )
    assert source.origins == ("shelf.example", "public.example")


# The CLI's daily npm check is off in every trial process.
#
# Left on, it makes one request to a host no arm asked for. The proxy refuses
# it, the sentinel counts the refusal, and a trial that did its work correctly
# is thrown away.


def test_the_cli_and_the_daemon_environments_both_turn_the_npm_check_off(make_roots) -> None:
    source = tenjin_arm.dry_source()
    environment = tenjin_arm.cli_environment(source, {"PATH": "/usr/bin", "HOME": "/home/u"})
    assert environment[tenjin_arm.NO_UPDATE_CHECK] == "1"
    daemon = tenjin_arm.daemon_environment(make_roots("t1"), {"PATH": "/usr/bin"})
    assert daemon[tenjin_arm.NO_UPDATE_CHECK] == "1"


def test_the_daemon_environment_is_an_allowlist_and_carries_no_proxy_names(make_roots) -> None:
    # Harbor's egress control is an nftables redirect in a sidecar sharing the
    # namespace, so the daemon needs to be told nothing to be intercepted. The
    # old design had to hand it proxy variables, and a process that missed them
    # reached nothing at all on an `--internal` network.
    parent = {
        "PATH": "/usr/bin",
        "LANG": "C.UTF-8",
        "HTTPS_PROXY": "http://proxy:8888",
        "NODE_USE_ENV_PROXY": "1",
        "AWS_SECRET_ACCESS_KEY": "nope",
    }
    env = tenjin_arm.daemon_environment(make_roots("t2"), parent)
    assert env["LANG"] == "C.UTF-8"
    assert "HTTPS_PROXY" not in env
    assert "NODE_USE_ENV_PROXY" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env


# The run's identity to the product, and the two host environments that carry it.
#
# A public leg the marketplace cannot tell from a person's question is counted
# as demand and ranks on a public page. The field that separates them is the
# User-Agent, and the only client label the server reads is the LEADING
# product, so every case here judges the head of the field.

NONCE = "20260909T010203Z-deadbeef"


def test_the_leading_product_is_the_eval_product_and_the_version_names_the_run() -> None:
    value = tenjin_arm.caller_user_agent(NONCE)
    name, version = tenjin_arm.leading_product(value)
    assert name == tenjin_arm.EVAL_PRODUCT
    assert version == f"{tenjin_arm.BENCH_PRODUCT}-{NONCE}"
    assert tenjin_arm.leads_with_eval(value)


def test_the_version_still_fits_the_field_the_server_keeps_it_in() -> None:
    """32 characters survive there and this value fills exactly that, so a longer nonce truncates silently."""
    _, version = tenjin_arm.leading_product(tenjin_arm.caller_user_agent(NONCE))
    assert len(version or "") <= tenjin_arm.PRODUCT_VERSION_LIMIT


def test_the_nonce_a_run_mints_survives_inside_a_product_token() -> None:
    """A character the server's token alphabet excludes would cut the field short, so the two shapes are pinned together."""
    assert cli.NONCE.match(NONCE)
    assert tenjin_arm.leads_with_eval(tenjin_arm.caller_user_agent(NONCE))


def test_an_absent_or_wrongly_led_field_is_not_the_eval_product() -> None:
    composed = f"tenjin-cli/0.1.0-alpha.15 {tenjin_arm.caller_user_agent(NONCE)} (+https://tenjin.blog)"
    # `composed` is the field the product's own handoff produces today: the
    # CLI's identity leads and the eval product rides behind it, which the
    # server reads as `tenjin-cli`. See the README section on the gap.
    for value in (None, "", "tenjin-cli/0.1.0-alpha.15", composed, "tenjin-evaluation/1", " tenjin-eval/1"):
        assert not tenjin_arm.leads_with_eval(value), value


def test_the_eval_product_is_matched_the_way_the_demand_gate_matches_it() -> None:
    """The gate lowers the stored token, so a capitalised spelling is the same client, not a different one."""
    assert tenjin_arm.leads_with_eval("Tenjin-Eval/1")


def test_the_seeding_cli_environment_carries_it() -> None:
    value = tenjin_arm.caller_user_agent(NONCE)
    parent = {"PATH": "/usr/bin", "HOME": "/home/u", tenjin_arm.CALLER_USER_AGENT: value}
    assert tenjin_arm.cli_environment(tenjin_arm.dry_source(), parent)[tenjin_arm.CALLER_USER_AGENT] == value


def test_the_daemon_environment_carries_it(make_roots) -> None:
    value = tenjin_arm.caller_user_agent(NONCE)
    parent = {"PATH": "/usr/bin", tenjin_arm.CALLER_USER_AGENT: value}
    assert tenjin_arm.daemon_environment(make_roots("ua1"), parent)[tenjin_arm.CALLER_USER_AGENT] == value


def test_neither_environment_invents_one_the_parent_does_not_have(make_roots) -> None:
    """A default here would name every run the same and hide the case the refusals exist for."""
    assert tenjin_arm.CALLER_USER_AGENT not in tenjin_arm.cli_environment(tenjin_arm.dry_source(), {"PATH": "/usr/bin"})
    assert tenjin_arm.CALLER_USER_AGENT not in tenjin_arm.daemon_environment(make_roots("ua2"), {"PATH": "/usr/bin"})
