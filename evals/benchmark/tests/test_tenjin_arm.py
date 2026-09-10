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

from evals.benchmark import artifact, cli, executor, loop_join, manifest as manifest_module, records, runner, schedule, signature, tenjin_arm, vendor, verifier
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec, ProvisionError, ProvisionRequest
from evals.benchmark.tests import support

FAKE_DAEMON = [sys.executable, str(Path(__file__).with_name("fake_daemon.py"))]
FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
SECRET = "bench1-test-shelf-secret-0123456789abcdef"
LIVE = "live_provisioned_for_this_test"
PROBE_MJS = "console.error('Error: ENOENT: no such file or directory, open \\'settings.json\\'');\nconsole.error('    at load (/tmp/x/src/load.mjs:3:9)');\nprocess.exit(1);\n"

WriteSource = Callable[..., Path]
Prepare = Callable[..., executor.Provision]


def _gone(pid: int, deadline_s: float = 5.0) -> bool:
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return True
        time.sleep(0.02)
    return False


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
    assert seeded["hooks"] == {"capture": "off"}
    assert seeded["team"] == {"publicFallback": "on"}
    assert seeded["loop"] == {"idle_exit_min": 2, "port": 4321}
    assert seeded["shelfBypassSecret"] == SECRET
    assert "wallet" not in seeded
    assert "shelfBypassSecret" not in tenjin_arm.seeded_config(source, 1, with_secret=False)


@pytest.fixture
def fake_daemon() -> Iterator[None]:
    """Every daemon this module starts is `tests/fake_daemon.py`."""
    with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON)):
        yield


@pytest.fixture
def source(write_source: WriteSource) -> tenjin_arm.Source:
    return tenjin_arm.load_source(write_source())


@pytest.fixture
def prepare(source: tenjin_arm.Source, fake_daemon: None) -> Iterator[Prepare]:
    """`tenjin_arm.prepare` with the daemon it starts stopped when the case ends."""
    started: list[tuple[Any, Path]] = []

    def run(roots: artifact.TrialRoots, *, dry_run: bool = False) -> executor.Provision:
        provision = tenjin_arm.prepare(ProvisionRequest(roots.trial_id, roots, {"id": "tenjin_seeded", "provision": "tenjin"}, source, dry_run=dry_run))
        if provision.stop_state.get("started") is not None:
            started.append((provision.stop_state["started"], roots.run_dir))
        return provision

    yield run
    for process, run_dir in started:
        with contextlib.suppress(Exception):
            runner.process_stop(process, run_dir, 2.0)


def test_prepare_seeds_the_data_dir_starts_one_daemon_and_stop_ends_it_with_the_wal(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    provision = prepare(roots)
    data = roots.data_dir
    assert sorted(path.name for path in (data / "hooks").iterdir()) == sorted(tenjin_arm.BUNDLES)
    token = (data / "daemon.token").read_text(encoding="utf-8")
    assert oct((data / "daemon.token").stat().st_mode & 0o777) == "0o600"
    seeded = json.loads((data / "config.json").read_text(encoding="utf-8"))
    assert seeded["shelfBypassSecret"] == SECRET
    assert seeded["team"] == {"publicFallback": "on"}
    pid_record = json.loads((data / "daemon.pid").read_text(encoding="utf-8"))
    assert provision.values["daemon_url"] == f"http://127.0.0.1:{pid_record['port']}/hook/claude"
    assert provision.values["daemon_token"] == token
    assert provision.values["data_dir"] == str(data)
    assert provision.secrets == (SECRET,)
    assert provision.facts["shelf_origin"] == "team-shelf.example"
    assert (data / "loop.db-wal").exists()
    # The resolved hook URL and token are what the daemon accepts.
    request = urllib.request.Request(
        provision.values["daemon_url"], data=b"{}", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 204
    pid = provision.stop_state["pid"]
    assert tenjin_arm.stop(roots, provision) == {"respawned": False, "wal_live": False, "wal_checkpoint": None}
    assert _gone(pid)
    assert not (data / "loop.db-wal").exists()


def test_stop_reaches_a_daemon_the_shim_respawned_through_its_own_pid_record(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    provision = prepare(roots)
    ours = provision.stop_state["pid"]
    # A detached daemon the shim started is outside every group the
    # runner recorded; it announces itself only through daemon.pid.
    env = tenjin_arm.daemon_environment(roots)
    respawned = subprocess.Popen(FAKE_DAEMON + ["--port", "0"], cwd=roots.data_dir, env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        end = time.monotonic() + 5
        while time.monotonic() < end and (tenjin_arm.read_pid(roots.data_dir) or {}).get("pid") != respawned.pid:
            time.sleep(0.02)
        assert tenjin_arm.read_pid(roots.data_dir)["pid"] == respawned.pid
        # The respawned daemon is this test's child, so it lingers as a zombie
        # until waited on; the grace wait is shortened for that reason alone.
        with mock.patch.object(tenjin_arm, "STOP_GRACE_S", 0.5):
            report = tenjin_arm.stop(roots, provision)
        assert report["respawned"]
        assert respawned.wait(timeout=5) is not None
        assert _gone(ours)
    finally:
        if respawned.poll() is None:
            respawned.kill()
            respawned.wait(timeout=5)


def test_a_pid_record_that_does_not_answer_for_this_data_dir_is_left_alone(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    provision = prepare(roots)
    stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    try:
        # A stale or forged record naming a live process that is not a daemon.
        (roots.data_dir / "daemon.pid").write_text(json.dumps({"pid": stranger.pid, "port": 1, "started_at": 0, "data_dir": str(roots.data_dir)}), encoding="utf-8")
        report = tenjin_arm.stop(roots, provision)
        assert not report["respawned"]
        assert stranger.poll() is None, "a process that never answered /health for this data dir must not be signalled"
    finally:
        stranger.kill()
        stranger.wait(timeout=5)


def test_a_wal_the_daemon_leaves_behind_is_closed_at_stop_not_waited_out(make_roots, prepare: Prepare) -> None:
    # The daemon exits without removing its WAL and the timeout is zero, so
    # the only thing that can settle this trial is the checkpoint.
    roots = make_roots()
    with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON) + ["--keep-wal"]), mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.0):
        provision = prepare(roots)
        report = tenjin_arm.stop(roots, provision)
    assert (report["wal_live"], report["wal_checkpoint"]) == (False, None)
    assert not (roots.data_dir / "loop.db-wal").exists()


# A daemon that died without closing its database, which is what the container
# teardown produces: the frames are committed and the `-wal` is real.
ORPHAN_WAL = """
import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE IF NOT EXISTS fires (id TEXT)")
db.execute("INSERT INTO fires VALUES ('f1')")
db.commit()
{tail}
"""


def orphan_wal(loop_db: Path, tail: str = "os._exit(0)") -> subprocess.Popen[bytes]:
    process = subprocess.Popen([sys.executable, "-c", ORPHAN_WAL.format(tail=tail), str(loop_db)])
    if tail == "os._exit(0)":
        assert process.wait(timeout=30) == 0
    return process


def test_the_stop_path_closes_the_wal_instead_of_waiting_for_it(tmp_path: Path) -> None:
    # WAL_TIMEOUT_S is zero, so nothing here can pass by waiting: the frames
    # are gone because the checkpoint moved them, and they are still readable
    # in the main file afterwards, which is what the join is about to do.
    data = tmp_path / "data"
    data.mkdir()
    orphan_wal(data / "loop.db")
    assert loop_join.wal_live(data / "loop.db"), "the case needs a WAL with frames in it"
    with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.0):
        assert tenjin_arm.settle_wal(data) == {"wal_live": False, "wal_checkpoint": None}
    assert not (data / "loop.db-wal").exists()
    connection = sqlite3.connect(f"file:{(data / 'loop.db').as_posix()}?mode=ro&immutable=1", uri=True)
    try:
        assert connection.execute("SELECT id FROM fires").fetchall() == [("f1",)]
    finally:
        connection.close()


def test_a_checkpoint_another_connection_refuses_stays_an_invalid_attempt(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    holder = orphan_wal(data / "loop.db", tail="db.execute('BEGIN IMMEDIATE')\nimport time; time.sleep(30)")
    try:
        end = time.monotonic() + 10
        while time.monotonic() < end and not loop_join.wal_live(data / "loop.db"):
            time.sleep(0.02)
        assert loop_join.wal_live(data / "loop.db")
        with mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2):
            report = tenjin_arm.settle_wal(data)
        assert report["wal_live"], "a checkpoint that could not run leaves the attempt invalid"
        assert report["wal_checkpoint"] != tenjin_arm.WAL_UNCLOSED and "checkpoint" in report["wal_checkpoint"]
    finally:
        holder.kill()
        holder.wait(timeout=5)


def test_a_data_dir_with_no_ledger_settles_without_creating_one(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    assert tenjin_arm.settle_wal(data) == {"wal_live": False, "wal_checkpoint": None}
    assert not (data / "loop.db").exists(), "settling must not bring a ledger into being"


def test_a_daemon_that_never_answers_is_stopped_and_refused(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
    with mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: sleeper), mock.patch.object(tenjin_arm, "HEALTH_TIMEOUT_S", 0.3):
        with pytest.raises(ProvisionError) as caught:
            prepare(roots)
    assert "/health" in str(caught.value)


def test_a_dry_run_seeds_without_a_secret_a_token_or_a_daemon(make_roots, prepare: Prepare) -> None:
    roots = make_roots()
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        provision = prepare(roots, dry_run=True)
    assert not (roots.data_dir / "daemon.token").exists()
    seeded = json.loads((roots.data_dir / "config.json").read_text(encoding="utf-8"))
    assert "shelfBypassSecret" not in seeded
    assert provision.values["daemon_url"] == "http://127.0.0.1:0/hook/claude"
    assert provision.values["daemon_token"] == tenjin_arm.DRY_TOKEN
    assert provision.stop_state == {}
    assert tenjin_arm.stop(roots, provision) == {"respawned": False, "wal_live": False, "wal_checkpoint": None}


def test_the_daemon_environment_is_the_trials_own(make_roots) -> None:
    roots = make_roots()
    env = tenjin_arm.daemon_environment(roots, {"PATH": "/usr/bin", "LANG": "C", "TENJIN_WALLET_PRIVATE_KEY": "0xdead", "HOME": "/Users/operator"})
    assert sorted(env) == ["HOME", "LANG", "PATH", "TENJIN_DATA_DIR"]
    assert env["HOME"] == str(roots.home)
    assert env["TENJIN_DATA_DIR"] == os.path.abspath(roots.data_dir)


def test_the_seeded_secret_is_a_canary_everywhere_but_the_seeded_config(make_roots) -> None:
    roots = make_roots()
    (roots.data_dir / "config.json").write_text(json.dumps({"shelfBypassSecret": SECRET}), encoding="utf-8")
    exclude = (roots.data_dir / "config.json",)
    assert artifact.scan_sentinels(roots, 0, canaries=(SECRET,), exclude=exclude).credential_exposures == 0
    (roots.repo / "notes.md").write_text(f"header {SECRET}\n", encoding="utf-8")
    transcript = roots.profile / "projects" / "p" / "root.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"text": SECRET}) + "\n", encoding="utf-8")
    (roots.output / "daemon.log").write_text(f"sent {SECRET}\n", encoding="utf-8")
    report = artifact.scan_sentinels(roots, 0, canaries=(SECRET,), exclude=exclude)
    assert report.credential_exposures == 3
    assert report.reason == "sentinel:credential_exposure"


# The runner's provision flow, with the fake executor's launch and the fake daemon.


@pytest.fixture
def live_arm(register_executor, fake_daemon: None) -> None:
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
    seeded_manifest, make_runtime, run_dir: Path
) -> None:
    seen: list[tuple[bool, bool]] = []

    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        seen.append((tenjin_arm.read_pid(roots.data_dir) is not None, (roots.data_dir / "loop.db-wal").exists()))

    runtime = make_runtime(spawn=support.fake_spawn(before=before))
    record = runner.run_trial(seeded_manifest, trial_of(seeded_manifest, "tenjin_seeded"), run_dir, "sha256:schedule", runtime)
    records.validate(record)
    # The daemon was up while the agent ran, and gone with its WAL before the join.
    assert seen == [(True, True)]
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


def test_a_wal_the_checkpoint_cannot_close_still_makes_the_attempt_invalid(seeded_manifest, make_runtime, run_dir: Path) -> None:
    # A checkpoint that refuses is the one case the timeout was ever standing
    # in for, and it stays an invalid attempt that says why in the record.
    with (
        mock.patch.object(tenjin_arm, "DAEMON_ARGV", lambda roots: list(FAKE_DAEMON) + ["--keep-wal"]),
        mock.patch.object(tenjin_arm, "WAL_TIMEOUT_S", 0.2),
        mock.patch.object(tenjin_arm, "checkpoint_wal", return_value=tenjin_arm.WAL_BUSY),
    ):
        record = runner.run_trial(seeded_manifest, trial_of(seeded_manifest, "tenjin_seeded"), run_dir, "sha256:schedule", make_runtime())
    assert (record["outcome"], record["invalid_reason"]) == ("invalid", "delivery:wal_live")
    assert record["isolation"]["wal_checkpoint"] == tenjin_arm.WAL_BUSY


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


def test_team_and_public_fallback_legs_are_named_origins_and_an_unknown_shelf_is_a_public_request(
    seeded_manifest, make_runtime, run_dir: Path, public_source
) -> None:
    trial = trial_of(seeded_manifest, "tenjin_seeded")
    # A team miss that fell back to the public marketplace: two named legs.
    record = runner.run_trial(
        seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=legs("team", "public")), source=public_source)
    )
    assert record["delivery"]["classes"] == {"team": 1, "public": 1, "local": 0, "other": 0}
    assert record["sentinel"]["public_requests"] == 0
    assert record["outcome"] == "pass"
    # A leg to a shelf this package cannot name is a request to an unknown origin.
    record = runner.run_trial(
        seeded_manifest, trial, run_dir, "sha256:schedule", make_runtime(spawn=support.fake_spawn(before=legs("team", "mirror")), source=public_source)
    )
    assert record["delivery"]["shelves"] == {"team": 1, "public": 0, "keys": 0, "local": 0, "other": 1}
    assert record["delivery"]["classes"] == {"team": 1, "public": 0, "local": 0, "other": 1}
    assert (record["outcome"], record["invalid_reason"]) == ("invalid", "sentinel:public_request")
    assert record["sentinel"]["public_requests"] == 1


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
    assert record["sentinel"]["public_requests"] == 0
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
    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a dry run starts nothing")):
        payload = cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=stream, environ={}, tenjin_source=write_source())
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
        assert any(hook.startswith("SubagentStart http http://127.0.0.1:0/hook/claude headers=Authorization") for hook in plan["hooks"])
        assert any("tenjin-shim.mjs" in hook and hook.startswith("SessionStart command") for hook in plan["hooks"])
    assert "shelf_secret_present=true shelf_origin=team-shelf.example" in printed
    # The vendored toolchain is named, with the host verdict, and nothing was extracted.
    assert "vendor    vitest-3.2.4-node24-darwin-arm64 platform=darwin-arm64 node_abi=137 host=" in printed
    assert ("extracted into repo/node_modules" if vendor.host_platform() == "darwin-arm64" else "MISMATCH") in printed
    # The archive is a release asset, so the line states whether this checkout has it.
    assert ("live-run fetches it first" in printed) is not payload["trials"][0]["vendor"]["present"]
    for plan in payload["trials"]:
        assert plan["vendor"]["id"] == "vitest-3.2.4-node24-darwin-arm64"
        assert plan["vendor"]["present"] is installed.vendor_for(installed.tasks[0]).archive.is_file()
        assert not (Path(plan["roots"]["cwd"]) / "node_modules" / "vitest").exists()
    assert SECRET not in printed
    assert tenjin_arm.DRY_TOKEN not in printed
    for plan in payload["trials"]:
        if plan["arm_id"] == "off":
            assert plan["hooks"] == []
            assert plan["provision"] is None


def test_the_dry_run_needs_no_source(run_dir: Path) -> None:
    payload = cli.live_run(run_dir, cli.HOOKS_SMOKE_MANIFEST, dry_run=True, stream=io.StringIO(), environ={})
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


# The lesson seed on a fake CLI: keyed publish at prepare, delete at stop, every outcome in the facts.


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


@pytest.fixture
def seed_lane(lessons: Path, fake_daemon: None) -> Iterator[None]:
    """The lesson directory and every `tenjin` invocation replaced by the fake CLI."""
    assert PROBE_KEY is not None
    (lessons / "fam.md").write_text("# The lesson\n\nRun the one file.\n", encoding="utf-8")
    write_lesson(lessons, PROBE_KEY)
    patches = [
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


@pytest.fixture
def seed_request(source: tenjin_arm.Source, seed_roots: artifact.TrialRoots, seed_lane: None) -> Callable[..., ProvisionRequest]:
    def build(nonce: str | None = "20260908T000000Z-0badf00d", **overrides: object) -> ProvisionRequest:
        base = dict(task={"id": "probe", "family": "fam"}, environment={"PATH": os.environ.get("PATH", ""), "HOME": str(seed_roots.home)}, nonce=nonce)
        base.update(overrides)
        return ProvisionRequest(seed_roots.trial_id, seed_roots, {"id": "tenjin_seeded", "provision": "tenjin"}, source, **base)  # type: ignore[arg-type]

    return build


@pytest.fixture
def calls(source: tenjin_arm.Source) -> Callable[[], list[dict]]:
    def read() -> list[dict]:
        path = Path(source.path) / "cli-calls.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    return read


@pytest.fixture
def stop_seeded(seed_roots: artifact.TrialRoots) -> Iterator[list[executor.Provision]]:
    """Every provision a seed case opened, stopped at the end of the case."""
    opened: list[executor.Provision] = []
    yield opened
    for provision in opened:
        started = provision.stop_state.get("started")
        if started is not None:
            with contextlib.suppress(Exception):
                runner.process_stop(started, seed_roots.run_dir, 2.0)


def test_prepare_probes_publishes_with_the_key_and_stop_deletes(seed_roots, seed_request, calls, stop_seeded) -> None:
    provision = tenjin_arm.prepare(seed_request())
    stop_seeded.append(provision)
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
    lessons: Path, seed_roots, seed_request, calls, stop_seeded, family_session
) -> None:
    fix_key = write_fix_lesson(lessons)
    provision = tenjin_arm.prepare(seed_request())
    stop_seeded.append(provision)
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


def test_an_envelope_on_stderr_is_read_by_shape(source, seed_request, stop_seeded) -> None:
    (Path(source.path) / "envelope-on-stderr").write_text("", encoding="utf-8")
    provision = tenjin_arm.prepare(seed_request())
    stop_seeded.append(provision)
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


def test_a_task_without_a_lesson_seeds_nothing(seed_request, calls, stop_seeded) -> None:
    provision = tenjin_arm.prepare(seed_request(task={"id": "x", "family": "smoke"}))
    stop_seeded.append(provision)
    assert "seed" not in provision.facts
    assert calls() == []


def test_an_arm_may_name_exactly_the_lessons_it_seeds(lessons: Path, seed_roots, seed_request, stop_seeded) -> None:
    write_fix_lesson(lessons)
    request = seed_request()
    request = ProvisionRequest(request.trial_id, request.roots, {**request.arm, "lessons": ["probe-fix"]}, request.source, task=request.task, environment=request.environment, nonce=request.nonce)
    provision = tenjin_arm.prepare(request)
    stop_seeded.append(provision)
    assert [seed["lesson"] for seed in provision.facts["seed"]] == ["probe-fix"]
    assert sorted(path.name for path in (seed_roots.data_dir / "hooks").iterdir()) == sorted(tenjin_arm.BUNDLES)
    assert "tenjin-vitest-reporter.mjs" in tenjin_arm.BUNDLES
    with pytest.raises(ProvisionError):
        tenjin_arm.lessons_for({"id": "probe", "family": "fam"}, selected=["absent"])


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
