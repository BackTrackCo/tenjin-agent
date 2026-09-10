"""Fixture images: tag identity, labels, the build argv, and the refusals a live run makes before it spends."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from evals.benchmark import images
from evals.benchmark.images import Completed, ImageError

PINS = {"harness_version": "2.1.263"}
FIXTURE_HASH = "sha256:" + "ab" * 32
TASK = {"id": "actor", "fixture_hash": FIXTURE_HASH}
# The CLI build, stated rather than read off this checkout: the suite is stdlib
# Python that can run before `pnpm build` on a fresh clone, and every assertion
# here is about what the recipe and the labels do with a build, not about which
# build this machine happens to hold.
CLI = images.CliBuild(root=Path("/checkout"), hash="sha256:" + "cd" * 32, commit="9f1c0d3", files=("package.json", "dist"))


def checkout(root: Path, entry: str = "#!/usr/bin/env node\n", skill: str = "skill\n") -> Path:
    """A built checkout: the package manifest, the entry point, and one more path its `files` names."""
    (root / "dist").mkdir(parents=True, exist_ok=True)
    (root / "dist" / "index.js").write_text(entry, encoding="utf-8")
    (root / "skills").mkdir(parents=True, exist_ok=True)
    (root / "skills" / "SKILL.md").write_text(skill, encoding="utf-8")
    manifest = {"name": "tenjin-cli", "version": "0.1.0-alpha.15", "bin": {"tenjin": "dist/index.js"}, "files": ["dist", "skills"]}
    (root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def fake_git(head: str | None = "c0ffee1", status: str | None = "") -> images.Git:
    """`git` as two answers: what HEAD is, and whether the tree differs from it."""

    def git(root: Path, *argv: str) -> str | None:
        return head if argv[0] == "rev-parse" else status

    return git


class FakeDocker:
    """Records every argv and answers from a table keyed by the first two words."""

    def __init__(self, table: dict[str, Completed] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.table = table or {}

    def key(self, argv: list[str]) -> str:
        return " ".join(argv[:2])

    def __call__(self, argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        self.calls.append(list(argv))
        for width in (2, 1):
            answer = self.table.get(" ".join(argv[:width]))
            if answer is not None:
                return answer
        return Completed(returncode=0, stdout="", stderr="")

    def flag(self, index: int, name: str) -> list[str]:
        """Every value of a repeated flag in the recorded call at `index`."""
        argv = self.calls[index]
        return [argv[position + 1] for position, token in enumerate(argv) if token == name]


def inspect_payload(labels: dict[str, str], image_id: str = "sha256:feed") -> Completed:
    return Completed(returncode=0, stdout=json.dumps({"Id": image_id, "Config": {"Labels": labels}}), stderr="")


def labels_for(fixture_hash: str = FIXTURE_HASH, base_id: str = "sha256:base") -> dict[str, str]:
    return images.fixture_labels("actor", fixture_hash, images.recipe(PINS, CLI), base_id)


def test_the_tag_names_the_task_and_the_fixture_hash() -> None:
    assert images.fixture_tag("actor", FIXTURE_HASH) == "bench2-actor:" + "ab" * 6


def test_a_fixture_hash_that_is_not_a_token_is_refused() -> None:
    with pytest.raises(ImageError) as caught:
        images.fixture_tag("actor", "d19a2b57")
    assert caught.value.code == "fixture_hash"


def test_the_base_tag_changes_with_the_pinned_harness_version() -> None:
    first = images.base_tag(images.recipe(PINS, CLI))
    second = images.base_tag(images.recipe({"harness_version": "2.1.264"}, CLI))
    assert first.startswith("bench2-base:")
    assert first != second


def test_the_base_tag_changes_with_the_dockerfile_and_the_entrypoint() -> None:
    """An edit to either is an image change, or a run reuses a stale one.

    On 2026-09-09 the recipe named only versions, so a fix to the trial
    entrypoint left the tag unchanged and two four-attempt runs silently
    used the image built before it.
    """
    base = images.recipe(PINS, CLI)
    assert "dockerfile" in base
    assert "entrypoint" in base
    for name, path in (("dockerfile", images.BASE_DOCKERFILE), ("entrypoint", images.TRIAL_SCRIPT)):
        assert base[name] == images.file_hash(path)
        changed = {**base, name: "sha256:" + "0" * 64}
        assert images.base_tag(base) != images.base_tag(changed)


def test_a_recipe_without_a_harness_version_is_refused() -> None:
    with pytest.raises(ImageError) as caught:
        images.recipe({}, CLI)
    assert caught.value.code == "recipe_pins"


def test_the_base_tag_changes_when_the_cli_build_changes() -> None:
    """A CLI change is a new image, or the lane measures the build before it.

    The image installs this checkout's CLI, so the built package is an image
    input like the Dockerfile is. An unhashed input means a changed file
    leaves the tag unchanged and the run silently reuses a stale image.
    """
    built = images.recipe(PINS, CLI)
    assert built["tenjin_cli"] == CLI.hash
    changed = images.recipe(PINS, images.CliBuild(root=CLI.root, hash="sha256:" + "ef" * 32, commit=CLI.commit, files=CLI.files))
    assert images.base_tag(built) != images.base_tag(changed)


def test_no_published_cli_version_is_an_image_input() -> None:
    """A version string does not identify a build, so the recipe never names one."""
    assert "tenjin" not in images.recipe(PINS, CLI)
    assert not hasattr(images, "TENJIN_VERSION")


def test_the_labels_carry_the_fixture_hash_the_base_and_every_pin() -> None:
    labels = labels_for()
    assert labels["bench2.task"] == "actor"
    assert labels["bench2.fixture_hash"] == FIXTURE_HASH
    assert labels["bench2.base_id"] == "sha256:base"
    assert labels["bench2.claude"] == "2.1.263"
    assert labels["bench2.base_digest"] == images.BASE_DIGEST


def test_the_labels_name_the_cli_build_and_the_commit_it_came_from() -> None:
    labels = images.fixture_labels("actor", FIXTURE_HASH, images.recipe(PINS, CLI), "sha256:base", CLI.commit)
    assert labels["bench2.tenjin_cli"] == CLI.hash
    assert labels["bench2.cli_commit"] == CLI.commit


# The CLI the image installs: this checkout's build, by content and by commit.


def test_the_build_hashes_the_package_and_stages_what_files_names(tmp_path: Path) -> None:
    cli = images.cli_build(checkout(tmp_path), fake_git())
    assert cli.hash.startswith("sha256:")
    assert cli.files == ("package.json", "dist", "skills")


def test_a_changed_dist_is_a_changed_build(tmp_path: Path) -> None:
    first = images.cli_build(checkout(tmp_path), fake_git()).hash
    second = images.cli_build(checkout(tmp_path, entry="#!/usr/bin/env node\n// fixed\n"), fake_git()).hash
    assert first != second


def test_a_change_anywhere_the_package_ships_is_a_changed_build(tmp_path: Path) -> None:
    """`files` names more than `dist`, and every path it names reaches the agent."""
    first = images.cli_build(checkout(tmp_path), fake_git()).hash
    second = images.cli_build(checkout(tmp_path, skill="skill\nmore\n"), fake_git()).hash
    assert first != second


def test_an_unbuilt_checkout_names_the_command_that_builds_it(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(json.dumps({"name": "tenjin-cli", "files": ["dist"]}), encoding="utf-8")
    with pytest.raises(ImageError) as caught:
        images.cli_build(tmp_path, fake_git())
    assert caught.value.code == "cli_unbuilt"
    assert "pnpm build" in caught.value.detail


def test_a_files_entry_that_is_not_a_path_here_is_refused(tmp_path: Path) -> None:
    checkout(tmp_path)
    manifest = json.loads((tmp_path / "package.json").read_text(encoding="utf-8"))
    (tmp_path / "package.json").write_text(json.dumps({**manifest, "files": ["dist", "docs/**"]}), encoding="utf-8")
    with pytest.raises(ImageError) as caught:
        images.cli_build(tmp_path, fake_git())
    assert caught.value.code == "cli_files"


def test_a_package_without_a_files_list_is_refused(tmp_path: Path) -> None:
    checkout(tmp_path)
    (tmp_path / "package.json").write_text(json.dumps({"name": "tenjin-cli"}), encoding="utf-8")
    with pytest.raises(ImageError) as caught:
        images.cli_build(tmp_path, fake_git())
    assert caught.value.code == "cli_manifest"


def test_the_commit_is_head_and_says_so_when_the_tree_differs(tmp_path: Path) -> None:
    clean = images.cli_build(checkout(tmp_path), fake_git(head="c0ffee1", status=""))
    assert clean.commit == "c0ffee1"
    dirty = images.cli_build(tmp_path, fake_git(head="c0ffee1", status=" M src/index.ts"))
    assert dirty.commit == "c0ffee1-dirty"


def test_a_checkout_outside_a_repository_says_unknown_rather_than_guessing(tmp_path: Path) -> None:
    cli = images.cli_build(checkout(tmp_path), fake_git(head=None))
    assert cli.commit == images.UNKNOWN_COMMIT


def test_a_missing_image_names_the_command_that_builds_it() -> None:
    docker = FakeDocker({"image inspect": Completed(returncode=1, stdout="", stderr="No such image")})
    with pytest.raises(ImageError) as caught:
        images.require(TASK, PINS, docker, CLI)
    assert caught.value.code == "image_missing"
    assert "images build" in caught.value.detail


def test_an_image_built_from_another_pin_is_drift_not_a_silent_run() -> None:
    stale = {**labels_for(), "bench2.claude": "2.1.200"}
    docker = FakeDocker({"image inspect": inspect_payload(stale)})
    with pytest.raises(ImageError) as caught:
        images.require(TASK, PINS, docker, CLI)
    assert caught.value.code == "image_drift"
    assert "2.1.200" in caught.value.detail


def test_the_base_id_is_not_compared_because_a_rebuilt_base_is_not_drift() -> None:
    docker = FakeDocker({"image inspect": inspect_payload(labels_for(base_id="sha256:another"))})
    image = images.require(TASK, PINS, docker, CLI)
    assert image.facts["base_id"] == "sha256:another"
    assert image.facts["fixture_hash"] == FIXTURE_HASH


def test_an_image_built_from_another_cli_build_is_drift() -> None:
    stale = {**labels_for(), "bench2.tenjin_cli": "sha256:" + "ef" * 32}
    docker = FakeDocker({"image inspect": inspect_payload(stale)})
    with pytest.raises(ImageError) as caught:
        images.require(TASK, PINS, docker, CLI)
    assert caught.value.code == "image_drift"
    assert "tenjin_cli" in caught.value.detail


def test_a_new_commit_of_an_identical_build_is_not_drift() -> None:
    """The commit is a source pointer, not an image input: a rebuild it cannot change is not a rebuild."""
    labels = {**labels_for(), "bench2.cli_commit": "0a1b2c3"}
    docker = FakeDocker({"image inspect": inspect_payload(labels)})
    image = images.require(TASK, PINS, docker, CLI)
    assert image.facts["cli"] == {"build": CLI.hash, "commit": "0a1b2c3"}


def test_the_facts_a_record_carries_name_the_cli_build_and_its_commit() -> None:
    docker = FakeDocker({"image inspect": inspect_payload(labels_for() | {"bench2.cli_commit": CLI.commit})})
    facts = images.require(TASK, PINS, docker, CLI).facts
    assert facts["cli"] == {"build": CLI.hash, "commit": CLI.commit}


def test_an_unreadable_inspect_is_a_refusal_rather_than_a_crash() -> None:
    docker = FakeDocker({"image inspect": Completed(returncode=0, stdout="not json", stderr="")})
    with pytest.raises(ImageError) as caught:
        images.inspect("bench2-actor:abc", docker)
    assert caught.value.code == "inspect_unreadable"


class SpyDocker(FakeDocker):
    """A docker that also reads the build context, which lives only for the call."""

    def __init__(self, table: dict[str, Completed] | None = None) -> None:
        super().__init__(table)
        self.contexts: list[list[str]] = []

    def __call__(self, argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        context = Path(argv[-1])
        if argv[0] == "build" and context.is_dir():
            self.contexts.append(sorted(item.relative_to(context).as_posix() for item in context.rglob("*") if item.is_file()))
        return super().__call__(argv, timeout_s, stream)


@pytest.fixture
def cli(tmp_path: Path) -> images.CliBuild:
    return images.cli_build(checkout(tmp_path), fake_git())


def test_the_base_build_passes_every_pin_as_a_build_argument(cli: images.CliBuild) -> None:
    docker = FakeDocker({"image inspect": inspect_payload({})})
    images.build_base(images.recipe(PINS, cli), docker, None, cli)
    arguments = docker.flag(0, "--build-arg")
    assert f"BASE_DIGEST={images.BASE_DIGEST}" in arguments
    assert "CLAUDE_VERSION=2.1.263" in arguments
    assert f"PNPM_VERSION={images.PNPM_VERSION}" in arguments
    # No published-CLI pin reaches the build: the package is copied in.
    assert [value for value in arguments if value.startswith("TENJIN")] == []


def test_the_base_context_is_staged_and_carries_this_checkouts_cli(cli: images.CliBuild) -> None:
    """The context is built for the call, because the CLI package does not live beside the Dockerfile."""
    docker = SpyDocker({"image inspect": inspect_payload({})})
    images.build_base(images.recipe(PINS, cli), docker, None, cli)
    assert docker.calls[0][-1] != str(images.DOCKER_DIR)
    assert docker.contexts[0] == ["cli/dist/index.js", "cli/package.json", "cli/skills/SKILL.md", "trial.mjs"]
    # The staged context is disposable, so nothing of it survives the build.
    assert not Path(docker.calls[0][-1]).exists()


def test_a_fixture_build_uses_the_fixture_directory_as_its_whole_context() -> None:
    docker = FakeDocker({"image inspect": inspect_payload(labels_for())})
    base = images.Image(tag="bench2-base:x", id="sha256:base", labels={})
    fixture = Path("/tmp/fixtures/actor")
    images.build_fixture(TASK, fixture, images.recipe(PINS, CLI), base, docker, None, CLI)
    argv = docker.calls[0]
    assert argv[-1] == str(fixture)
    assert "--file" in argv
    assert argv[argv.index("--file") + 1] == str(images.FIXTURE_DOCKERFILE)
    assert f"bench2.fixture_hash={FIXTURE_HASH}" in docker.flag(0, "--label")
    assert "BASE_TAG=bench2-base:x" in docker.flag(0, "--build-arg")
    assert f"bench2.cli_commit={CLI.commit}" in docker.flag(0, "--label")
    assert f"bench2.tenjin_cli={CLI.hash}" in docker.flag(0, "--label")


def test_a_failed_build_names_the_tag_and_the_exit_code(cli: images.CliBuild) -> None:
    docker = FakeDocker({"build": Completed(returncode=1, stdout="", stderr="boom")})
    with pytest.raises(ImageError) as caught:
        images.build_base(images.recipe(PINS, cli), docker, None, cli)
    assert caught.value.code == "base_build_failed"


class StagingDocker(FakeDocker):
    """A `docker cp` that writes an installed tree into the staging directory it was given."""

    def __init__(self, link: tuple[str, str] | None = None) -> None:
        super().__init__({"create": Completed(returncode=0, stdout="c0ffee\n", stderr="")})
        self.link = link

    def __call__(self, argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        answer = super().__call__(argv, timeout_s, stream)
        if argv[:1] == ["cp"]:
            staging = Path(argv[-1])
            (staging / "package.json").write_text("{}\n", encoding="utf-8")
            tree = staging / images.NODE_MODULES / "vitest"
            tree.mkdir(parents=True, exist_ok=True)
            (tree / "index.js").write_text("runner\n", encoding="utf-8")
            if self.link is not None:
                name, target = self.link
                made = staging / images.NODE_MODULES / name
                made.parent.mkdir(parents=True, exist_ok=True)
                made.symlink_to(target)
        return answer


@pytest.fixture
def destination(tmp_path: Path) -> Path:
    return tmp_path / "node_modules"


@pytest.fixture
def image() -> images.Image:
    return images.Image(tag="bench2-actor:abc", id="sha256:feed", labels={})


def test_the_copy_container_is_removed_even_when_the_copy_fails(destination: Path, image: images.Image) -> None:
    docker = FakeDocker(
        {
            "create": Completed(returncode=0, stdout="c0ffee\n", stderr=""),
            "cp": Completed(returncode=1, stdout="", stderr="no such path"),
        }
    )
    with pytest.raises(ImageError) as caught:
        images.export_node_modules(image, destination, docker)
    assert caught.value.code == "export_failed"
    assert docker.calls[-1] == ["rm", "--force", "c0ffee"]


def test_the_copy_reads_the_image_tree_into_the_destination(destination: Path, image: images.Image) -> None:
    docker = StagingDocker()
    count = images.export_node_modules(image, destination, docker)
    assert count == 1
    assert (destination / "vitest" / "index.js").read_text(encoding="utf-8") == "runner\n"
    # Staged from the fixture root, not from `node_modules`, and only the
    # installed tree is moved on: the trial's own fixture files are the
    # copy the runner made and never the image's.
    assert docker.calls[1][:2] == ["cp", "c0ffee:/opt/fixture/."]
    assert not (destination / "package.json").exists()
    assert [path.name for path in destination.parent.iterdir()] == ["node_modules"]
    assert docker.calls[-1] == ["rm", "--force", "c0ffee"]


def test_a_workspace_link_out_of_node_modules_survives_the_copy(destination: Path, image: images.Image) -> None:
    """`docker cp` refuses a link that leaves the directory it copies, so the copy starts a level up.

    Measured 2026-09-09 on the `shadow` fixture: copying `node_modules`
    itself failed with `invalid symlink ... -> ../../packages/range`, which
    is the link every workspace consumer resolves through.
    """
    docker = StagingDocker(link=("@fixture/range", "../../packages/range"))
    images.export_node_modules(image, destination, docker)
    link = destination / "@fixture" / "range"
    assert link.is_symlink()
    assert os.readlink(link) == "../../packages/range"


def test_an_image_with_no_installed_tree_is_a_refusal_rather_than_an_empty_copy(destination: Path, image: images.Image) -> None:
    docker = FakeDocker({"create": Completed(returncode=0, stdout="c0ffee\n", stderr="")})
    with pytest.raises(ImageError) as caught:
        images.export_node_modules(image, destination, docker)
    assert caught.value.code == "export_failed"
    assert docker.calls[-1] == ["rm", "--force", "c0ffee"]


# A task whose difficulty is a runtime behaviour states it, and the build proves the image still has it.


def test_a_task_with_no_hidden_check_runs_no_container() -> None:
    docker = FakeDocker()
    assert images.quirk_check("actor", "bench2-actor:abc", docker) is None
    assert docker.calls == []


def test_a_declared_check_runs_in_the_image_read_only_and_off_the_network() -> None:
    docker = FakeDocker({"run": Completed(returncode=0, stdout="still there\n", stderr="")})
    assert images.quirk_check("ambient", "bench2-ambient:abc", docker) == "still there"
    argv = docker.calls[0]
    assert argv[:2] == ["run", "--rm"]
    assert argv[argv.index("--network") + 1] == "none"
    assert argv[argv.index("--volume") + 1] == f"{images.HIDDEN / 'ambient'}:{images.CHECK_PATH}:ro"
    assert argv[-1] == f"{images.CHECK_PATH}/{images.QUIRK_CHECK}"


def test_an_image_that_lost_the_quirk_fails_the_build_by_name() -> None:
    docker = FakeDocker({"run": Completed(returncode=1, stdout="", stderr="AssertionError: Intl no longer renders 9")})
    with pytest.raises(ImageError) as caught:
        images.quirk_check("ambient", "bench2-ambient:abc", docker)
    assert caught.value.code == "image_quirk_absent"
    assert "Intl no longer renders" in caught.value.detail


def test_the_ambient_check_is_the_task_that_declares_one() -> None:
    declared = sorted(path.parent.name for path in images.HIDDEN.glob(f"*/{images.QUIRK_CHECK}"))
    assert declared == ["ambient"]


def test_the_ledger_records_every_tag_its_id_and_the_recipe(tmp_path: Path) -> None:
    path = tmp_path / "images.json"
    built = images.ledger_write(
        {"bench2-actor:abc": images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for())},
        images.recipe(PINS, CLI),
        path,
        CLI,
    )
    assert built["recipe"]["claude"] == "2.1.263"
    assert built["cli"] == {"build": CLI.hash, "commit": CLI.commit}
    read = images.ledger_read(path)
    assert read["images"]["bench2-actor:abc"]["id"] == "sha256:feed"


def test_a_missing_ledger_reads_as_empty_rather_than_raising() -> None:
    assert images.ledger_read(Path("/nonexistent/images.json")) == {}


# A record names the CLI build it measured, because the version string does not.


def image_record(image: Any) -> dict[str, Any]:
    from evals.benchmark.tests import support

    base = support.attempt_record(support.parse("sess-family"))
    return {**base, "isolation": {**base["isolation"], "image": image}}


UNNAMED_CLI = images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for()).facts


def test_the_record_carries_the_cli_build_and_the_commit_under_the_image() -> None:
    from evals.benchmark import records

    facts = images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for() | {"bench2.cli_commit": CLI.commit}).facts
    record = image_record(facts)
    records.validate(record)
    assert record["isolation"]["image"]["cli"] == {"build": CLI.hash, "commit": CLI.commit}


@pytest.mark.parametrize("bad", (UNNAMED_CLI, {**UNNAMED_CLI, "cli": {"build": CLI.hash}}, {**UNNAMED_CLI, "cli": "0.1.0-alpha.15"}, "bench2-actor:abc"))
def test_an_image_that_cannot_name_its_cli_build_is_refused(bad: Any) -> None:
    from evals.benchmark import records

    with pytest.raises(records.RecordError):
        records.validate(image_record(bad))


# The pnpm a trial runs is the image's, and the record says so.


def test_a_launch_records_the_images_pnpm_and_seeds_nothing_on_the_host(tmp_path: Path) -> None:
    from evals.benchmark import artifact, claude_live, cli, manifest as manifest_module, schedule

    manifest = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)
    trial = next(item for item in schedule.expand(manifest) if item.arm_id == "off")
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    roots = artifact.create(tmp_path / "run", trial.trial_id, manifest.fixture_path(task))
    launch = claude_live.launch(claude_live.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins))
    assert launch.package_manager == {"kind": "image", "version": images.PNPM_VERSION}
    # Nothing of the host's package manager reaches the trial: no corepack
    # home, no cache seeded beside the roots, no version probed.
    assert "COREPACK_HOME" not in launch.recipe.environment
    assert "COREPACK_HOME" not in launch.container_plan["env"]
    assert not (roots.base / "corepack").exists()


@pytest.mark.parametrize("name", ("COREPACK_HOME", "NODE_OPTIONS", "PATH"))
def test_an_arm_cannot_reach_the_package_manager_through_its_settings(name: str) -> None:
    from evals.benchmark import claude_live

    with pytest.raises(claude_live.LiveExecutorError):
        claude_live._settings_env({name: "/elsewhere"})


def test_the_record_keeps_the_package_manager_in_its_isolation_block() -> None:
    from evals.benchmark import records
    from evals.benchmark.tests import support

    record = support.attempt_record(support.parse("sess-family"))
    record["isolation"] = {**record["isolation"], "package_manager": {"kind": "image", "version": images.PNPM_VERSION}}
    records.validate(record)
    for bad in ({"kind": "npm", "version": "1"}, {"kind": "image"}, {"kind": "image", "version": ""}, "image"):
        with pytest.raises(records.RecordError):
            records.validate({**record, "isolation": {**record["isolation"], "package_manager": bad}})


def test_a_daemon_that_does_not_answer_is_one_sentence() -> None:
    docker = FakeDocker({"info": Completed(returncode=1, stdout="", stderr="cannot connect")})
    reason = images.unavailable(docker)
    assert reason is not None
    assert "container" in str(reason)


def test_a_reachable_daemon_reports_nothing() -> None:
    assert images.unavailable(FakeDocker()) is None


def test_no_docker_on_path_is_the_same_sentence_rather_than_a_traceback() -> None:
    def missing(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
        raise ImageError("docker_missing", "no `docker` on PATH; a live trial runs inside a container")

    assert "no `docker` on PATH" in str(images.unavailable(missing))
