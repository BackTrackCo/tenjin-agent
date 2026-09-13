"""Disposable roots, sentinels, and the refusal a publishable live run meets."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest
from inline_snapshot import snapshot

from evals.benchmark import artifact, executor
from evals.benchmark.artifact import ArtifactError, Attestation, IsolationError
from evals.benchmark.tests.support import ATTESTED

Create = Callable[..., artifact.TrialRoots]


@pytest.fixture
def fixture(tmp_path: Path) -> Path:
    path = tmp_path / "fixture"
    path.mkdir()
    (path / "TASK.md").write_text("Write 42 into answer.txt.\n", encoding="utf-8")
    return path


@pytest.fixture
def create(tmp_path: Path, fixture: Path) -> Create:
    def build(trial_id: str = "trial-a", **kwargs: object) -> artifact.TrialRoots:
        return artifact.create(tmp_path / "run", trial_id, fixture, **kwargs)  # type: ignore[arg-type]

    return build


def test_each_trial_gets_unique_home_profile_data_repo_and_output_roots(create: Create) -> None:
    first, second = create("trial-a"), create("trial-b")
    for name in ("home", "profile", "data_dir", "repo", "output"):
        one, other = getattr(first, name), getattr(second, name)
        assert one != other
        assert one.is_dir() and other.is_dir()
        assert one.is_relative_to(first.base) and other.is_relative_to(second.base)
    assert len({str(getattr(first, name)) for name in ("home", "profile", "data_dir", "repo", "output")}) == 5
    assert (first.repo / "TASK.md").is_file()
    assert first.canary_token != second.canary_token


def test_a_phase_gets_its_own_roots_and_shares_the_consumer_data_dir_and_repo_path(tmp_path: Path, fixture: Path) -> None:
    run_dir = tmp_path / "run"
    roots = artifact.create(run_dir, "trial-x", fixture)
    assert (roots.trial_id, roots.run_dir, roots.phase) == ("trial-x", run_dir, None)
    producer = artifact.create(run_dir, "trial-x", fixture, phase="producer", data_dir=roots.data_dir)
    assert producer.data_dir == roots.data_dir
    assert producer.repo == roots.repo
    assert producer.base == roots.base / "producer"
    assert producer.home != roots.home
    assert producer.canary_token != roots.canary_token
    assert (producer.trial_id, producer.run_dir, producer.phase) == ("trial-x", run_dir, "producer")
    (producer.repo / "edited.txt").write_text("x\n", encoding="utf-8")
    artifact.refresh_repo(roots, fixture, None)
    assert not (roots.repo / "edited.txt").exists()
    assert (roots.repo / "TASK.md").is_file()


def test_a_reused_trial_root_is_rebuilt_from_the_fixture(create: Create) -> None:
    first = create("trial-a")
    (first.repo / "scratch.txt").write_text("left over\n", encoding="utf-8")
    assert not (create("trial-a").repo / "scratch.txt").exists()


def test_the_environment_is_an_allowlist_naming_the_trial_roots(create: Create) -> None:
    roots = create()
    env = roots.environment("/usr/bin")
    assert set(env) == {"PATH", "HOME", "TENJIN_DATA_DIR", "TENJIN_PUBLISH_MODE", "CLAUDE_CONFIG_DIR"}
    assert env["HOME"] == str(roots.home)
    assert env["TENJIN_DATA_DIR"] == str(roots.data_dir)
    assert env["CLAUDE_CONFIG_DIR"] == str(roots.profile)


def test_hidden_verifier_bytes_are_unavailable_before_agent_shutdown(create: Create, tmp_path: Path) -> None:
    roots = create()
    hidden = tmp_path / "hidden"
    hidden.mkdir()
    (hidden / "expected.txt").write_text("42\n", encoding="utf-8")
    with pytest.raises(ArtifactError) as caught:
        roots.hidden_copy(hidden)
    assert caught.value.code == "agent_live"
    assert not roots.verify.exists()
    assert not (roots.repo / "expected.txt").exists()
    roots.mark_stopped()
    copy = roots.hidden_copy(hidden)
    assert (copy / "expected.txt").read_text(encoding="utf-8") == "42\n"
    # The hidden layer lands in the verifier's copy, never on the mount the
    # agent had.
    assert not (roots.repo / "expected.txt").exists()


def test_a_symlink_out_of_the_worktree_fails_closed(create: Create, fixture: Path) -> None:
    roots = create()
    (roots.repo / "escape").symlink_to(fixture / "TASK.md")
    roots.mark_stopped()
    for call in (roots.audit, roots.hidden_copy):
        with pytest.raises(ArtifactError) as caught:
            call()
        assert caught.value.code == "symlink_escape"
    assert not roots.verify.exists()


def test_a_symlinked_directory_out_of_the_worktree_fails_closed(create: Create, tmp_path: Path) -> None:
    roots = create()
    (roots.repo / "elsewhere").symlink_to(tmp_path, target_is_directory=True)
    roots.mark_stopped()
    with pytest.raises(ArtifactError) as caught:
        roots.hidden_copy()
    assert caught.value.code == "symlink_escape"


def test_a_link_inside_the_worktree_stays_a_link_in_the_copy(create: Create) -> None:
    roots = create()
    (roots.repo / "alias.md").symlink_to(roots.repo / "TASK.md")
    roots.mark_stopped()
    assert (roots.hidden_copy() / "alias.md").is_symlink()


def test_a_missing_hidden_layer_fails_closed(create: Create, tmp_path: Path) -> None:
    roots = create()
    roots.mark_stopped()
    with pytest.raises(ArtifactError) as caught:
        roots.hidden_copy(tmp_path / "absent")
    assert caught.value.code == "hidden_layer_missing"


@pytest.fixture
def roots(create: Create) -> artifact.TrialRoots:
    return create()


def test_a_clean_trial_reports_no_sentinel_evidence(roots: artifact.TrialRoots) -> None:
    report = artifact.scan_sentinels(roots)
    assert report.counts() == {"credential_exposures": 0}
    assert report.reason is None


def test_the_planted_credential_lives_in_the_disposable_home_only(roots: artifact.TrialRoots) -> None:
    planted = roots.home / artifact.CREDENTIAL_FILE
    assert roots.canary_token in planted.read_text(encoding="utf-8")
    assert artifact.scan_sentinels(roots).reason is None


def test_a_credential_that_walks_into_a_trial_artifact_is_counted(roots: artifact.TrialRoots) -> None:
    (roots.repo / "notes.txt").write_text(f"key={roots.canary_token}\n", encoding="utf-8")
    (roots.output / "sent.json").write_text(f'{{"k":"{roots.canary_token}"}}', encoding="utf-8")
    report = artifact.scan_sentinels(roots)
    assert report.credential_exposures == 2
    assert report.reason == "sentinel:credential_exposure"


def test_a_fake_run_needs_no_attestation() -> None:
    isolation = artifact.require_isolation(live=False, publishable=True, attestation=None, ci=True)
    assert isolation["live"] is False
    assert isolation["attested_container"] is False
    assert isolation["attestation_hash"] is None


def test_a_publishable_live_run_is_refused_without_an_attestation() -> None:
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=True, attestation=None)
    assert caught.value.code == "attestation_missing"


def test_an_attested_live_run_is_allowed_and_hashed() -> None:
    isolation = artifact.require_isolation(live=True, publishable=True, attestation=ATTESTED, required_origins=("api.provider.example",))
    assert isolation["attested_container"] is True
    assert isolation["publishable"] is True
    assert isolation["attestation_hash"].startswith("sha256:")


def test_an_unattested_live_run_can_never_be_publishable() -> None:
    assert artifact.require_isolation(live=True, publishable=False, attestation=None) == snapshot(
        {
            "live": True,
            "publishable": False,
            "fresh_roots": True,
            "attested_container": False,
            "attestation_hash": None,
            "automated": False,
            "shelf_secret_present": False,
            "shelf_origin": None,
            "corpus": None,
        }
    )


def test_a_seeded_shelf_secret_is_non_publishable_by_construction() -> None:
    isolation = artifact.require_isolation(
        live=True, publishable=False, attestation=None, shelf_secret_present=True, shelf_origin="team-shelf.example"
    )
    assert (isolation["publishable"], isolation["shelf_secret_present"], isolation["shelf_origin"]) == (False, True, "team-shelf.example")
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=True, attestation=ATTESTED, shelf_secret_present=True)
    assert caught.value.code == "shelf_secret_publishable"
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=False, attestation=None, ci=True, automated=True, shelf_secret_present=True)
    assert caught.value.code == "automated_shelf_secret"


def test_a_live_run_in_ci_is_refused_unless_it_is_stamped_automated() -> None:
    # The stamp is what a reader checks the run against, so the one thing
    # CI may not do is let a record say a person watched it.
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=False, attestation=ATTESTED, ci=True)
    assert caught.value.code == "automated_unstamped"
    isolation = artifact.require_isolation(live=True, publishable=False, attestation=None, ci=True, automated=True)
    assert isolation["automated"] is True
    assert isolation["publishable"] is False
    assert isolation["attested_container"] is False


def test_an_automated_run_is_publishable_on_its_attestation_and_stays_stamped() -> None:
    # Publishability follows the attestation, not the launcher: the same
    # claim a person's run makes is the claim a scheduled run makes, and
    # `automated` remains in the record either way.
    isolation = artifact.require_isolation(
        live=True,
        publishable=True,
        attestation=ATTESTED,
        required_origins=("api.provider.example",),
        ci=True,
        automated=True,
    )
    assert (isolation["publishable"], isolation["automated"], isolation["attested_container"]) == (True, True, True)
    assert isolation["attestation_hash"] == ATTESTED.hash()


def test_an_automated_run_without_an_attestation_is_never_publishable() -> None:
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=True, attestation=None, ci=True, automated=True)
    assert caught.value.code == "attestation_missing"


def test_an_automated_run_whose_attestation_is_invalid_is_refused() -> None:
    # Valid, not merely present: the attestation is the whole of the claim,
    # so an unchecked one would make the new contract weaker than the old.
    loose = Attestation(**{**ATTESTED.__dict__, "network_allowlist": ("*",)})
    with pytest.raises(IsolationError) as caught:
        artifact.require_isolation(live=True, publishable=True, attestation=loose, ci=True, automated=True)
    assert caught.value.code == "open_network"


def test_the_registry_contains_only_supported_live_adapters() -> None:
    # Native adapters register lazily; collection order may have imported either.
    assert {spec.name for spec in executor.REGISTRY.values() if spec.live} <= {"claude_live", "codex_live"}


@pytest.mark.parametrize(
    ("code", "override"),
    [
        ("attestation_kind", {"kind": "laptop"}),
        ("attestation_field", {"instance_id": " "}),
        ("stale_roots", {"fresh_roots": False}),
        ("wallet_present", {"wallet_present": True}),
        ("open_network", {"network_allowlist": ()}),
        ("open_network", {"network_allowlist": ("*",)}),
    ],
)
def test_each_isolation_claim_fails_closed(code: str, override: dict) -> None:
    with pytest.raises(IsolationError) as caught:
        artifact.check_attestation(Attestation(**{**ATTESTED.__dict__, **override}))
    assert caught.value.code == code


def test_an_attestation_that_does_not_list_a_required_origin_fails_closed() -> None:
    with pytest.raises(IsolationError) as caught:
        artifact.check_attestation(ATTESTED, required_origins=("shelf.example", "unlisted.example"))
    assert caught.value.code == "allowlist_gap"
