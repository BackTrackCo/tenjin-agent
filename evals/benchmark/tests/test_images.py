"""Fixture images: what this package hands Harbor to name and build one, and the refusals a live run makes before it spends.

Harbor owns the hash and the `docker buildx build` behind it, and its own suite
covers both. What is pinned here is the seam: which context, which Dockerfile
and which build arguments each image is named from, that a fixture's name
carries the base's, that a missing name is a refusal rather than a silent reuse,
and that none of it reaches the offline closure.
"""

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
BASE_NAME = "bench2-base--1111111111111111"
CLI_BUILD = "cd" * 8
PLATFORM = "linux/arm64"
# The plan a live run resolves once. Stated rather than read off this checkout:
# the suite is stdlib Python that runs before `pnpm build` on a fresh clone and
# with no `harbor` importable, and every assertion here is about what this
# package does with a plan rather than which one this machine holds.
PLAN = images.Plan(
    context=Path("/staged"),
    platform=PLATFORM,
    args={"BASE_IMAGE": images.BASE_IMAGE, "BASE_DIGEST": images.BASE_DIGEST, "PNPM_VERSION": images.PNPM_VERSION, "CLAUDE_VERSION": "2.1.263"},
    base=BASE_NAME,
    cli_build=CLI_BUILD,
    commit="9f1c0d3",
)


def checkout(root: Path, entry: str = "#!/usr/bin/env node\n") -> Path:
    """A built checkout: the package manifest, the entry point, and one more path its `files` names."""
    (root / "dist").mkdir(parents=True, exist_ok=True)
    (root / "dist" / "index.js").write_text(entry, encoding="utf-8")
    (root / "skills").mkdir(parents=True, exist_ok=True)
    (root / "skills" / "SKILL.md").write_text("skill\n", encoding="utf-8")
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

    def __call__(self, argv: list[str], timeout_s: float = 0.0) -> Completed:
        self.calls.append(list(argv))
        for width in (2, 1):
            answer = self.table.get(" ".join(argv[:width]))
            if answer is not None:
                return answer
        return Completed(returncode=0, stdout="", stderr="")


class FakeBuild:
    """Harbor's four image symbols, recorded. The hash is a sorted digest of its own arguments, so a changed input is a changed name."""

    def __init__(self) -> None:
        self.hashed: list[dict[str, Any]] = []
        self.built: list[dict[str, Any]] = []

    def context_hash(self, *, context: Path, dockerfile_path: Path | None = None, build_args: Any = None, platform: str | None = None) -> str:
        call = {"context": str(context), "dockerfile": None if dockerfile_path is None else dockerfile_path.name, "args": dict(build_args or {}), "platform": platform}
        self.hashed.append(call)
        return format(abs(hash(json.dumps(call, sort_keys=True))) % (16**16), "016x")

    def name(self, stem: str, key: str) -> str:
        return f"{stem}--{key}"

    async def platform(self) -> str:
        return PLATFORM

    async def ensure(self, *, docker_name: str, docker_build_context: Path, dockerfile_path: Path, build_args: Any, platform: str, timeout_sec: float) -> str:
        self.built.append({"stem": docker_name, "context": str(docker_build_context), "dockerfile": dockerfile_path.name, "args": dict(build_args), "platform": platform})
        return self.name(docker_name, self.context_hash(context=docker_build_context, dockerfile_path=dockerfile_path, build_args=build_args, platform=platform))


@pytest.fixture
def build(monkeypatch: pytest.MonkeyPatch) -> FakeBuild:
    """Harbor, replaced at the seam this package resolves it through. No case here imports it."""
    fake = FakeBuild()
    monkeypatch.setattr(images, "harbor", lambda: images.Build(ensure=fake.ensure, context_hash=fake.context_hash, name=fake.name, platform=fake.platform))
    return fake


# What the base image is built from, and what a missing pin does.


def test_the_build_arguments_carry_the_pinned_base_and_every_version() -> None:
    args = images.build_args(PINS)
    assert args["BASE_DIGEST"] == images.BASE_DIGEST
    assert args["AGENT_VERSION"] == "2.1.263"
    assert args["PNPM_VERSION"] == images.PNPM_VERSION


def test_a_recipe_without_a_harness_version_is_refused() -> None:
    for pins in ({}, {"harness_version": ""}, {"harness_version": 2}):
        with pytest.raises(ImageError) as caught:
            images.build_args(pins)
        assert caught.value.code == "recipe_pins"


def test_no_published_cli_version_is_a_build_argument() -> None:
    """The image installs this checkout's build, so nothing here can pin a release instead."""
    assert not any("tenjin" in value.lower() for value in images.build_args(PINS).values())


# The CLI the image installs: which paths are staged, and which checkout they came from.


def test_the_staged_package_is_the_manifest_and_every_path_files_names(tmp_path: Path) -> None:
    assert images.cli_files(checkout(tmp_path)) == ("package.json", "dist", "skills")


def test_an_unbuilt_checkout_names_the_command_that_builds_it(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    (root / "dist" / "index.js").unlink()
    with pytest.raises(ImageError) as caught:
        images.cli_files(root)
    assert caught.value.code == "cli_unbuilt"
    assert "pnpm build" in caught.value.detail


def test_a_files_entry_that_is_not_a_path_here_is_refused(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    (root / "package.json").write_text(json.dumps({**manifest, "files": ["dist", "docs/**/*.md"]}), encoding="utf-8")
    with pytest.raises(ImageError) as caught:
        images.cli_files(root)
    assert caught.value.code == "cli_files"


def test_a_package_without_a_files_list_is_refused(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    (root / "package.json").write_text(json.dumps({key: value for key, value in manifest.items() if key != "files"}), encoding="utf-8")
    with pytest.raises(ImageError) as caught:
        images.cli_files(root)
    assert caught.value.code == "cli_manifest"


def test_the_staged_context_holds_the_entrypoint_and_the_package_and_nothing_else(tmp_path: Path) -> None:
    root = checkout(tmp_path / "checkout")
    context = images.stage_base(root, images.cli_files(root))
    assert sorted(path.name for path in context.iterdir()) == [images.CLI_STAGE, images.TRIAL_SCRIPT.name]
    staged = context / images.CLI_STAGE
    assert (staged / "package.json").is_file()
    assert (staged / "skills" / "SKILL.md").read_text(encoding="utf-8") == "skill\n"


def test_the_commit_is_head_and_says_so_when_the_tree_differs(tmp_path: Path) -> None:
    assert images.cli_commit(tmp_path, fake_git(head="c0ffee1", status="")) == "c0ffee1"
    assert images.cli_commit(tmp_path, fake_git(head="c0ffee1", status=" M src/index.ts")) == "c0ffee1-dirty"


def test_a_checkout_outside_a_repository_says_unknown_rather_than_guessing(tmp_path: Path) -> None:
    assert images.cli_commit(tmp_path, fake_git(head=None)) == images.UNKNOWN_COMMIT


# The names, and what they are hashed over.


def test_the_base_name_is_hashed_over_the_staged_context_the_dockerfile_and_every_pin(tmp_path: Path, build: FakeBuild) -> None:
    root = checkout(tmp_path)
    resolved = images.plan(PINS, root, fake_git())
    call = build.hashed[0]
    assert call["context"] == str(resolved.context)
    assert call["dockerfile"] == images.BASE_DOCKERFILE.name
    assert call["args"] == images.build_args(PINS)
    assert call["platform"] == PLATFORM
    assert resolved.base.startswith(images.BASE_STEM + "--")


def test_a_moved_pin_is_a_different_base_name(tmp_path: Path, build: FakeBuild) -> None:
    root = checkout(tmp_path)
    first = images.plan(PINS, root, fake_git()).base
    second = images.plan({"harness_version": "2.1.264"}, root, fake_git()).base
    assert first != second


def test_a_changed_entrypoint_or_cli_file_is_a_different_base_name(tmp_path: Path, build: FakeBuild) -> None:
    """The context is the entrypoint and the package, so Harbor's hash over it catches an edit to either.

    That is the property the hand-rolled recipe existed for: on 2026-09-09 an
    edit to the entrypoint left the tag unchanged and two four-attempt runs
    silently reused a stale image.
    """
    root = checkout(tmp_path / "one")
    other = checkout(tmp_path / "two", entry="#!/usr/bin/env node\n// fixed\n")
    assert images.plan(PINS, root, fake_git()).base != images.plan(PINS, other, fake_git()).base


def test_a_fixture_name_is_hashed_over_its_own_tree_and_the_base_it_sits_on(tmp_path: Path, build: FakeBuild) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    name = images.fixture_name(TASK, fixture, PLAN)
    call = build.hashed[-1]
    assert call["context"] == str(fixture)
    assert call["dockerfile"] == images.FIXTURE_DOCKERFILE.name
    assert call["args"] == {"BASE_TAG": BASE_NAME}
    assert name.startswith("bench2-actor--")


def test_a_moved_base_moves_every_fixture_name(tmp_path: Path, build: FakeBuild) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    other = images.Plan(context=PLAN.context, platform=PLAN.platform, args=PLAN.args, base="bench2-base--2222222222222222", cli_build=CLI_BUILD, commit=PLAN.commit)
    assert images.fixture_name(TASK, fixture, PLAN) != images.fixture_name(TASK, fixture, other)


def test_a_dry_run_states_the_stem_because_it_has_no_daemon_to_ask_for_a_platform() -> None:
    assert images.fixture_stem("actor") == "bench2-actor"


# What a live run does before it spends: the image is there, or it is not.


def test_a_missing_image_names_the_command_that_builds_it(tmp_path: Path, build: FakeBuild) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    docker = FakeDocker({"image inspect": Completed(returncode=1, stdout="", stderr="No such image")})
    with pytest.raises(ImageError) as caught:
        images.require(TASK, fixture, PINS, docker, PLAN)
    assert caught.value.code == "image_missing"
    assert "images build" in caught.value.detail
    assert images.fixture_name(TASK, fixture, PLAN) in caught.value.detail


def test_an_input_that_moved_is_a_missing_image_rather_than_a_silent_reuse(tmp_path: Path, build: FakeBuild) -> None:
    """There is no drift check because a moved input cannot name the image that is here.

    The daemon holds the name the first plan resolved; the second plan asks for
    another one and is told to build it.
    """
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    present = images.fixture_name(TASK, fixture, PLAN)
    moved = images.Plan(context=PLAN.context, platform=PLAN.platform, args=PLAN.args, base="bench2-base--3333333333333333", cli_build=CLI_BUILD, commit=PLAN.commit)

    def docker(argv: list[str], timeout_s: float = 0.0) -> Completed:
        found = argv[:2] == ["image", "inspect"] and argv[2] == present
        return Completed(returncode=0 if found else 1, stdout="sha256:feed" if found else "", stderr="")

    assert images.require(TASK, fixture, PINS, docker, PLAN).id == "sha256:feed"
    with pytest.raises(ImageError) as caught:
        images.require(TASK, fixture, PINS, docker, moved)
    assert caught.value.code == "image_missing"


def test_the_facts_a_record_carries_name_the_image_its_base_and_the_cli_build(tmp_path: Path, build: FakeBuild) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    docker = FakeDocker({"image inspect": Completed(returncode=0, stdout="sha256:feed\n", stderr="")})
    facts = images.require(TASK, fixture, PINS, docker, PLAN).facts
    assert facts["id"] == "sha256:feed"
    assert facts["fixture_hash"] == FIXTURE_HASH
    assert facts["base"] == BASE_NAME
    assert facts["cli"] == {"build": CLI_BUILD, "commit": "9f1c0d3"}


# The build: what Harbor is asked to build, in what order, and what is proved afterwards.


class FakeManifest:
    def __init__(self, root: Path, ids: tuple[str, ...]) -> None:
        self.pins = PINS
        self.tasks = [{"id": task_id, "fixture_hash": FIXTURE_HASH} for task_id in ids]
        self.root = root
        for task_id in ids:
            (root / task_id).mkdir(parents=True, exist_ok=True)
            (root / task_id / "package.json").write_text(json.dumps({"name": task_id}), encoding="utf-8")

    def fixture_path(self, task: Any) -> Path:
        return self.root / str(task["id"])


def test_the_build_makes_the_base_first_and_hands_its_name_to_every_fixture(tmp_path: Path, build: FakeBuild, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(images, "_plan", lambda pins, resolved=None: PLAN)
    docker = FakeDocker({"image inspect": Completed(returncode=0, stdout="sha256:feed\n", stderr="")})
    manifest = FakeManifest(tmp_path / "fixtures", ("actor", "slug"))
    monkeypatch.setattr(images, "build_image", lambda stem, context, dockerfile, args, resolved: BASE_NAME if stem == images.BASE_STEM else f"{stem}--0000")
    payload = images.build_all(manifest, docker, log=None, ledger=tmp_path / "images.json")
    assert payload["base"] == BASE_NAME
    assert sorted(payload["images"]) == ["bench2-actor--0000", BASE_NAME, "bench2-slug--0000"]
    assert payload["cli"] == {"build": CLI_BUILD, "commit": "9f1c0d3"}


def test_a_base_harbor_names_differently_than_this_run_resolved_is_refused(tmp_path: Path, build: FakeBuild, monkeypatch: pytest.MonkeyPatch) -> None:
    """A trial looks the image up by name, so a build that produced another one is a run that would refuse every trial."""
    monkeypatch.setattr(images, "_plan", lambda pins, resolved=None: PLAN)
    monkeypatch.setattr(images, "build_image", lambda *args: "bench2-base--9999999999999999")
    with pytest.raises(ImageError) as caught:
        images.build_all(FakeManifest(tmp_path / "fixtures", ("actor",)), FakeDocker(), log=None, ledger=tmp_path / "images.json")
    assert caught.value.code == "base_name"


def test_a_build_passes_the_context_the_dockerfile_and_the_platform_to_harbor(tmp_path: Path, build: FakeBuild) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    images.build_image("bench2-actor", fixture, images.FIXTURE_DOCKERFILE, {"BASE_TAG": BASE_NAME}, PLAN)
    assert build.built == [
        {"stem": "bench2-actor", "context": str(fixture), "dockerfile": images.FIXTURE_DOCKERFILE.name, "args": {"BASE_TAG": BASE_NAME}, "platform": PLATFORM}
    ]


def test_a_failed_build_names_the_image_and_what_harbor_said(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def refuse(**_: Any) -> str:
        raise RuntimeError("Failed to build Docker image bench2-actor--abc, exit code 1, output: pnpm install died")

    monkeypatch.setattr(images, "harbor", lambda: images.Build(ensure=refuse, context_hash=None, name=None, platform=None))
    with pytest.raises(ImageError) as caught:
        images.build_image("bench2-actor", tmp_path, images.FIXTURE_DOCKERFILE, {}, PLAN)
    assert caught.value.code == "build_failed"
    assert "pnpm install died" in caught.value.detail


# The installed tree an image carries, copied into the trial's repository.


class StagingDocker(FakeDocker):
    """A `docker cp` that writes an installed tree into the staging directory it was given."""

    def __init__(self, link: tuple[str, str] | None = None) -> None:
        super().__init__({"create": Completed(returncode=0, stdout="c0ffee\n", stderr="")})
        self.link = link

    def __call__(self, argv: list[str], timeout_s: float = 0.0) -> Completed:
        answer = super().__call__(argv, timeout_s)
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
    return images.Image(tag="bench2-actor--abc", id="sha256:feed")


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
    assert images.quirk_check("actor", "bench2-actor--abc", docker) is None
    assert docker.calls == []


def test_a_declared_check_runs_in_the_image_read_only_and_off_the_network() -> None:
    docker = FakeDocker({"run": Completed(returncode=0, stdout="still there\n", stderr="")})
    assert images.quirk_check("ambient", "bench2-ambient--abc", docker) == "still there"
    argv = docker.calls[0]
    assert argv[:2] == ["run", "--rm"]
    assert argv[argv.index("--network") + 1] == "none"
    assert argv[argv.index("--volume") + 1] == f"{images.HIDDEN / 'ambient'}:{images.CHECK_PATH}:ro"
    assert argv[-1] == f"{images.CHECK_PATH}/{images.QUIRK_CHECK}"


def test_an_image_that_lost_the_quirk_fails_the_build_by_name() -> None:
    docker = FakeDocker({"run": Completed(returncode=1, stdout="", stderr="AssertionError: Intl no longer renders 9")})
    with pytest.raises(ImageError) as caught:
        images.quirk_check("ambient", "bench2-ambient--abc", docker)
    assert caught.value.code == "image_quirk_absent"
    assert "Intl no longer renders" in caught.value.detail




def test_the_ledger_records_every_name_its_id_and_what_the_run_was_built_from(tmp_path: Path) -> None:
    path = tmp_path / "images.json"
    built = images.ledger_write({"bench2-actor--abc": images.Image(tag="bench2-actor--abc", id="sha256:feed", base=BASE_NAME, cli=PLAN.cli)}, PLAN, path)
    assert built["pins"]["CLAUDE_VERSION"] == "2.1.263"
    assert built["platform"] == PLATFORM
    assert built["cli"] == {"build": CLI_BUILD, "commit": "9f1c0d3"}
    read = images.ledger_read(path)
    assert read["images"]["bench2-actor--abc"]["id"] == "sha256:feed"


def test_a_missing_ledger_reads_as_empty_rather_than_raising() -> None:
    assert images.ledger_read(Path("/nonexistent/images.json")) == {}


# A record names the CLI build it measured, because the version string does not.


def image_record(image: Any) -> dict[str, Any]:
    from evals.benchmark.tests import support

    base = support.attempt_record(support.parse("sess-family"))
    return {**base, "isolation": {**base["isolation"], "image": image}}


NAMED = images.Image(tag="bench2-actor--abc", id="sha256:feed", base=BASE_NAME, cli=PLAN.cli).facts
UNNAMED_CLI = images.Image(tag="bench2-actor--abc", id="sha256:feed").facts


def test_the_record_carries_the_cli_build_and_the_commit_under_the_image() -> None:
    from evals.benchmark import records

    record = image_record(NAMED)
    records.validate(record)
    assert record["isolation"]["image"]["cli"] == {"build": CLI_BUILD, "commit": "9f1c0d3"}


@pytest.mark.parametrize("bad", (UNNAMED_CLI, {**NAMED, "cli": {"build": CLI_BUILD}}, {**NAMED, "cli": "0.1.0-alpha.15"}, "bench2-actor--abc"))
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


# Whether an image can be built or read here at all, answered in one sentence.


def test_a_daemon_that_does_not_answer_is_one_sentence() -> None:
    docker = FakeDocker({"info": Completed(returncode=1, stdout="", stderr="cannot connect")})
    reason = images.unavailable(docker)
    assert reason is not None
    assert "container" in str(reason)


def test_a_docker_without_buildkit_is_named_before_a_build_fails_halfway() -> None:
    """Harbor builds every image with `docker buildx build`, its egress sidecar included, and its Dockerfile needs `COPY --chmod`."""
    docker = FakeDocker({"buildx": Completed(returncode=1, stdout="", stderr="unknown command")})
    reason = images.unavailable(docker)
    assert reason is not None
    assert "buildx" in reason


def test_a_reachable_daemon_reports_nothing() -> None:
    assert images.unavailable(FakeDocker()) is None


def test_no_docker_on_path_is_the_same_sentence_rather_than_a_traceback() -> None:
    def missing(argv: list[str], timeout_s: float = 0.0) -> Completed:
        raise ImageError("docker_missing", "no `docker` on PATH; a live trial runs inside a container")

    assert "no `docker` on PATH" in str(images.unavailable(missing))


def test_no_harbor_in_the_offline_closure_is_a_refusal_that_names_the_requirements_file() -> None:
    """The offline suite installs twelve wheels and imports this module; Harbor is 89 and needs 3.12."""
    pytest.importorskip("evals.benchmark.images")
    try:
        import harbor  # noqa: F401
    except ImportError:
        with pytest.raises(ImageError) as caught:
            images.harbor()
        assert caught.value.code == "harbor_missing"
        assert "requirements-live.txt" in caught.value.detail


@pytest.fixture(autouse=True)
def generated_live_inputs(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    from evals.benchmark import cli
    from evals.benchmark.tests import live_inputs
    tmp_path = tmp_path_factory.mktemp("live-inputs")
    monkeypatch.setattr(cli, "SMOKE_MANIFEST", live_inputs.write(tmp_path / "plain-input"), raising=False)
    monkeypatch.setattr(cli, "HOOKS_SMOKE_MANIFEST", live_inputs.write(tmp_path / "hooks-input", hooks=True), raising=False)


@pytest.fixture(autouse=True)
def generated_quirk(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    hidden = tmp_path_factory.mktemp("hidden")
    (hidden / "ambient").mkdir(parents=True)
    (hidden / "ambient" / images.QUIRK_CHECK).write_text("// generated check\n")
    monkeypatch.setattr(images, "HIDDEN", hidden)
