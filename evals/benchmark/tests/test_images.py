"""Fixture images: tag identity, labels, the build argv, and the refusals a live run makes before it spends."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

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


class IdentityTest(unittest.TestCase):
    def test_the_tag_names_the_task_and_the_fixture_hash(self) -> None:
        self.assertEqual(images.fixture_tag("actor", FIXTURE_HASH), "bench2-actor:" + "ab" * 6)

    def test_a_fixture_hash_that_is_not_a_token_is_refused(self) -> None:
        with self.assertRaises(ImageError) as caught:
            images.fixture_tag("actor", "d19a2b57")
        self.assertEqual(caught.exception.code, "fixture_hash")

    def test_the_base_tag_changes_with_the_pinned_harness_version(self) -> None:
        first = images.base_tag(images.recipe(PINS, CLI))
        second = images.base_tag(images.recipe({"harness_version": "2.1.264"}, CLI))
        self.assertTrue(first.startswith("bench2-base:"))
        self.assertNotEqual(first, second)

    def test_the_base_tag_changes_with_the_dockerfile_and_the_entrypoint(self) -> None:
        """An edit to either is an image change, or a run reuses a stale one.

        On 2026-09-09 the recipe named only versions, so a fix to the trial
        entrypoint left the tag unchanged and two four-attempt runs silently
        used the image built before it.
        """
        base = images.recipe(PINS, CLI)
        self.assertIn("dockerfile", base)
        self.assertIn("entrypoint", base)
        for name, path in (("dockerfile", images.BASE_DOCKERFILE), ("entrypoint", images.TRIAL_SCRIPT)):
            self.assertEqual(base[name], images.file_hash(path))
            changed = {**base, name: "sha256:" + "0" * 64}
            self.assertNotEqual(images.base_tag(base), images.base_tag(changed))

    def test_a_recipe_without_a_harness_version_is_refused(self) -> None:
        with self.assertRaises(ImageError) as caught:
            images.recipe({}, CLI)
        self.assertEqual(caught.exception.code, "recipe_pins")

    def test_the_base_tag_changes_when_the_cli_build_changes(self) -> None:
        """A CLI change is a new image, or the lane measures the build before it.

        The image installs this checkout's CLI, so the built package is an image
        input like the Dockerfile is. An unhashed input means a changed file
        leaves the tag unchanged and the run silently reuses a stale image.
        """
        built = images.recipe(PINS, CLI)
        self.assertEqual(built["tenjin_cli"], CLI.hash)
        changed = images.recipe(PINS, images.CliBuild(root=CLI.root, hash="sha256:" + "ef" * 32, commit=CLI.commit, files=CLI.files))
        self.assertNotEqual(images.base_tag(built), images.base_tag(changed))

    def test_no_published_cli_version_is_an_image_input(self) -> None:
        """A version string does not identify a build, so the recipe never names one."""
        self.assertNotIn("tenjin", images.recipe(PINS, CLI))
        self.assertFalse(hasattr(images, "TENJIN_VERSION"))

    def test_the_labels_carry_the_fixture_hash_the_base_and_every_pin(self) -> None:
        labels = labels_for()
        self.assertEqual(labels["bench2.task"], "actor")
        self.assertEqual(labels["bench2.fixture_hash"], FIXTURE_HASH)
        self.assertEqual(labels["bench2.base_id"], "sha256:base")
        self.assertEqual(labels["bench2.claude"], "2.1.263")
        self.assertEqual(labels["bench2.base_digest"], images.BASE_DIGEST)

    def test_the_labels_name_the_cli_build_and_the_commit_it_came_from(self) -> None:
        labels = images.fixture_labels("actor", FIXTURE_HASH, images.recipe(PINS, CLI), "sha256:base", CLI.commit)
        self.assertEqual(labels["bench2.tenjin_cli"], CLI.hash)
        self.assertEqual(labels["bench2.cli_commit"], CLI.commit)


class CliBuildTest(unittest.TestCase):
    """The CLI the image installs: this checkout's build, by content and by commit."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_the_build_hashes_the_package_and_stages_what_files_names(self) -> None:
        cli = images.cli_build(checkout(self.root), fake_git())
        self.assertTrue(cli.hash.startswith("sha256:"))
        self.assertEqual(cli.files, ("package.json", "dist", "skills"))

    def test_a_changed_dist_is_a_changed_build(self) -> None:
        first = images.cli_build(checkout(self.root), fake_git()).hash
        second = images.cli_build(checkout(self.root, entry="#!/usr/bin/env node\n// fixed\n"), fake_git()).hash
        self.assertNotEqual(first, second)

    def test_a_change_anywhere_the_package_ships_is_a_changed_build(self) -> None:
        """`files` names more than `dist`, and every path it names reaches the agent."""
        first = images.cli_build(checkout(self.root), fake_git()).hash
        second = images.cli_build(checkout(self.root, skill="skill\nmore\n"), fake_git()).hash
        self.assertNotEqual(first, second)

    def test_an_unbuilt_checkout_names_the_command_that_builds_it(self) -> None:
        (self.root / "package.json").write_text(json.dumps({"name": "tenjin-cli", "files": ["dist"]}), encoding="utf-8")
        with self.assertRaises(ImageError) as caught:
            images.cli_build(self.root, fake_git())
        self.assertEqual(caught.exception.code, "cli_unbuilt")
        self.assertIn("pnpm build", caught.exception.detail)

    def test_a_files_entry_that_is_not_a_path_here_is_refused(self) -> None:
        checkout(self.root)
        manifest = json.loads((self.root / "package.json").read_text(encoding="utf-8"))
        (self.root / "package.json").write_text(json.dumps({**manifest, "files": ["dist", "docs/**"]}), encoding="utf-8")
        with self.assertRaises(ImageError) as caught:
            images.cli_build(self.root, fake_git())
        self.assertEqual(caught.exception.code, "cli_files")

    def test_a_package_without_a_files_list_is_refused(self) -> None:
        checkout(self.root)
        (self.root / "package.json").write_text(json.dumps({"name": "tenjin-cli"}), encoding="utf-8")
        with self.assertRaises(ImageError) as caught:
            images.cli_build(self.root, fake_git())
        self.assertEqual(caught.exception.code, "cli_manifest")

    def test_the_commit_is_head_and_says_so_when_the_tree_differs(self) -> None:
        clean = images.cli_build(checkout(self.root), fake_git(head="c0ffee1", status=""))
        self.assertEqual(clean.commit, "c0ffee1")
        dirty = images.cli_build(self.root, fake_git(head="c0ffee1", status=" M src/index.ts"))
        self.assertEqual(dirty.commit, "c0ffee1-dirty")

    def test_a_checkout_outside_a_repository_says_unknown_rather_than_guessing(self) -> None:
        cli = images.cli_build(checkout(self.root), fake_git(head=None))
        self.assertEqual(cli.commit, images.UNKNOWN_COMMIT)


class RequireTest(unittest.TestCase):
    def test_a_missing_image_names_the_command_that_builds_it(self) -> None:
        docker = FakeDocker({"image inspect": Completed(returncode=1, stdout="", stderr="No such image")})
        with self.assertRaises(ImageError) as caught:
            images.require(TASK, PINS, docker, CLI)
        self.assertEqual(caught.exception.code, "image_missing")
        self.assertIn("images build", caught.exception.detail)

    def test_an_image_built_from_another_pin_is_drift_not_a_silent_run(self) -> None:
        stale = {**labels_for(), "bench2.claude": "2.1.200"}
        docker = FakeDocker({"image inspect": inspect_payload(stale)})
        with self.assertRaises(ImageError) as caught:
            images.require(TASK, PINS, docker, CLI)
        self.assertEqual(caught.exception.code, "image_drift")
        self.assertIn("2.1.200", caught.exception.detail)

    def test_the_base_id_is_not_compared_because_a_rebuilt_base_is_not_drift(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload(labels_for(base_id="sha256:another"))})
        image = images.require(TASK, PINS, docker, CLI)
        self.assertEqual(image.facts["base_id"], "sha256:another")
        self.assertEqual(image.facts["fixture_hash"], FIXTURE_HASH)

    def test_an_image_built_from_another_cli_build_is_drift(self) -> None:
        stale = {**labels_for(), "bench2.tenjin_cli": "sha256:" + "ef" * 32}
        docker = FakeDocker({"image inspect": inspect_payload(stale)})
        with self.assertRaises(ImageError) as caught:
            images.require(TASK, PINS, docker, CLI)
        self.assertEqual(caught.exception.code, "image_drift")
        self.assertIn("tenjin_cli", caught.exception.detail)

    def test_a_new_commit_of_an_identical_build_is_not_drift(self) -> None:
        """The commit is a source pointer, not an image input: a rebuild it cannot change is not a rebuild."""
        labels = {**labels_for(), "bench2.cli_commit": "0a1b2c3"}
        docker = FakeDocker({"image inspect": inspect_payload(labels)})
        image = images.require(TASK, PINS, docker, CLI)
        self.assertEqual(image.facts["cli"], {"build": CLI.hash, "commit": "0a1b2c3"})

    def test_the_facts_a_record_carries_name_the_cli_build_and_its_commit(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload(labels_for() | {"bench2.cli_commit": CLI.commit})})
        facts = images.require(TASK, PINS, docker, CLI).facts
        self.assertEqual(facts["cli"], {"build": CLI.hash, "commit": CLI.commit})

    def test_an_unreadable_inspect_is_a_refusal_rather_than_a_crash(self) -> None:
        docker = FakeDocker({"image inspect": Completed(returncode=0, stdout="not json", stderr="")})
        with self.assertRaises(ImageError) as caught:
            images.inspect("bench2-actor:abc", docker)
        self.assertEqual(caught.exception.code, "inspect_unreadable")


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


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cli = images.cli_build(checkout(Path(self.tmp.name)), fake_git())

    def test_the_base_build_passes_every_pin_as_a_build_argument(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload({})})
        images.build_base(images.recipe(PINS, self.cli), docker, None, self.cli)
        arguments = docker.flag(0, "--build-arg")
        self.assertIn(f"BASE_DIGEST={images.BASE_DIGEST}", arguments)
        self.assertIn("CLAUDE_VERSION=2.1.263", arguments)
        self.assertIn(f"PNPM_VERSION={images.PNPM_VERSION}", arguments)
        # No published-CLI pin reaches the build: the package is copied in.
        self.assertEqual([value for value in arguments if value.startswith("TENJIN")], [])

    def test_the_base_context_is_staged_and_carries_this_checkouts_cli(self) -> None:
        """The context is built for the call, because the CLI package does not live beside the Dockerfile."""
        docker = SpyDocker({"image inspect": inspect_payload({})})
        images.build_base(images.recipe(PINS, self.cli), docker, None, self.cli)
        self.assertNotEqual(docker.calls[0][-1], str(images.DOCKER_DIR))
        self.assertEqual(docker.contexts[0], ["cli/dist/index.js", "cli/package.json", "cli/skills/SKILL.md", "trial.mjs"])
        # The staged context is disposable, so nothing of it survives the build.
        self.assertFalse(Path(docker.calls[0][-1]).exists())

    def test_a_fixture_build_uses_the_fixture_directory_as_its_whole_context(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload(labels_for())})
        base = images.Image(tag="bench2-base:x", id="sha256:base", labels={})
        fixture = Path("/tmp/fixtures/actor")
        images.build_fixture(TASK, fixture, images.recipe(PINS, CLI), base, docker, None, CLI)
        argv = docker.calls[0]
        self.assertEqual(argv[-1], str(fixture))
        self.assertIn("--file", argv)
        self.assertEqual(argv[argv.index("--file") + 1], str(images.FIXTURE_DOCKERFILE))
        self.assertIn(f"bench2.fixture_hash={FIXTURE_HASH}", docker.flag(0, "--label"))
        self.assertIn("BASE_TAG=bench2-base:x", docker.flag(0, "--build-arg"))
        self.assertIn(f"bench2.cli_commit={CLI.commit}", docker.flag(0, "--label"))
        self.assertIn(f"bench2.tenjin_cli={CLI.hash}", docker.flag(0, "--label"))

    def test_a_failed_build_names_the_tag_and_the_exit_code(self) -> None:
        docker = FakeDocker({"build": Completed(returncode=1, stdout="", stderr="boom")})
        with self.assertRaises(ImageError) as caught:
            images.build_base(images.recipe(PINS, self.cli), docker, None, self.cli)
        self.assertEqual(caught.exception.code, "base_build_failed")


class ExportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.destination = Path(self.tmp.name) / "node_modules"
        self.image = images.Image(tag="bench2-actor:abc", id="sha256:feed", labels={})

    def test_the_copy_container_is_removed_even_when_the_copy_fails(self) -> None:
        docker = FakeDocker(
            {
                "create": Completed(returncode=0, stdout="c0ffee\n", stderr=""),
                "cp": Completed(returncode=1, stdout="", stderr="no such path"),
            }
        )
        with self.assertRaises(ImageError) as caught:
            images.export_node_modules(self.image, self.destination, docker)
        self.assertEqual(caught.exception.code, "export_failed")
        self.assertEqual(docker.calls[-1], ["rm", "--force", "c0ffee"])

    def test_the_copy_reads_the_image_tree_into_the_destination(self) -> None:
        docker = FakeDocker({"create": Completed(returncode=0, stdout="c0ffee\n", stderr="")})
        count = images.export_node_modules(self.image, self.destination, docker)
        self.assertEqual(count, 0)
        self.assertTrue(self.destination.is_dir())
        self.assertEqual(docker.calls[1][:2], ["cp", "c0ffee:/opt/fixture/node_modules/."])
        self.assertEqual(docker.calls[-1], ["rm", "--force", "c0ffee"])


class LedgerTest(unittest.TestCase):
    def test_the_ledger_records_every_tag_its_id_and_the_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "images.json"
            built = images.ledger_write(
                {"bench2-actor:abc": images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for())},
                images.recipe(PINS, CLI),
                path,
                CLI,
            )
            self.assertEqual(built["recipe"]["claude"], "2.1.263")
            self.assertEqual(built["cli"], {"build": CLI.hash, "commit": CLI.commit})
            read = images.ledger_read(path)
            self.assertEqual(read["images"]["bench2-actor:abc"]["id"], "sha256:feed")

    def test_a_missing_ledger_reads_as_empty_rather_than_raising(self) -> None:
        self.assertEqual(images.ledger_read(Path("/nonexistent/images.json")), {})


class RecordTest(unittest.TestCase):
    """A record names the CLI build it measured, because the version string does not."""

    def record(self, image: Any) -> dict[str, Any]:
        from evals.benchmark.tests import support

        base = support.attempt_record(support.parse("sess-family"))
        return {**base, "isolation": {**base["isolation"], "image": image}}

    def test_the_record_carries_the_cli_build_and_the_commit_under_the_image(self) -> None:
        from evals.benchmark import records

        facts = images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for() | {"bench2.cli_commit": CLI.commit}).facts
        record = self.record(facts)
        records.validate(record)
        self.assertEqual(record["isolation"]["image"]["cli"], {"build": CLI.hash, "commit": CLI.commit})

    def test_an_image_that_cannot_name_its_cli_build_is_refused(self) -> None:
        from evals.benchmark import records

        facts = images.Image(tag="bench2-actor:abc", id="sha256:feed", labels=labels_for()).facts
        for bad in (facts, {**facts, "cli": {"build": CLI.hash}}, {**facts, "cli": "0.1.0-alpha.15"}, "bench2-actor:abc"):
            with self.subTest(str(bad)), self.assertRaises(records.RecordError):
                records.validate(self.record(bad))


class PackageManagerTest(unittest.TestCase):
    """The pnpm a trial runs is the image's, and the record says so."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_a_launch_records_the_images_pnpm_and_seeds_nothing_on_the_host(self) -> None:
        from evals.benchmark import artifact, claude_live, cli, manifest as manifest_module, schedule

        manifest = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)
        trial = next(item for item in schedule.expand(manifest) if item.arm_id == "off")
        task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
        arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
        roots = artifact.create(self.dir / "run", trial.trial_id, manifest.fixture_path(task))
        launch = claude_live.launch(claude_live.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins))
        self.assertEqual(launch.package_manager, {"kind": "image", "version": images.PNPM_VERSION})
        assert launch.env is not None
        # Nothing of the host's package manager reaches the trial: no corepack
        # home, no cache seeded beside the roots, no version probed.
        self.assertNotIn("COREPACK_HOME", launch.env)
        self.assertNotIn("COREPACK_HOME", launch.container_plan["env"])
        self.assertFalse((roots.base / "corepack").exists())

    def test_an_arm_cannot_reach_the_package_manager_through_its_settings(self) -> None:
        from evals.benchmark import claude_live

        for name in ("COREPACK_HOME", "NODE_OPTIONS", "PATH"):
            with self.subTest(name), self.assertRaises(claude_live.LiveExecutorError):
                claude_live._settings_env({name: "/elsewhere"})

    def test_the_record_keeps_the_package_manager_in_its_isolation_block(self) -> None:
        from evals.benchmark import records
        from evals.benchmark.tests import support

        record = support.attempt_record(support.parse("sess-family"))
        record["isolation"] = {**record["isolation"], "package_manager": {"kind": "image", "version": images.PNPM_VERSION}}
        records.validate(record)
        for bad in ({"kind": "npm", "version": "1"}, {"kind": "image"}, {"kind": "image", "version": ""}, "image"):
            with self.subTest(str(bad)), self.assertRaises(records.RecordError):
                records.validate({**record, "isolation": {**record["isolation"], "package_manager": bad}})


class AvailabilityTest(unittest.TestCase):
    def test_a_daemon_that_does_not_answer_is_one_sentence(self) -> None:
        docker = FakeDocker({"info": Completed(returncode=1, stdout="", stderr="cannot connect")})
        reason = images.unavailable(docker)
        self.assertIsNotNone(reason)
        self.assertIn("container", str(reason))

    def test_a_reachable_daemon_reports_nothing(self) -> None:
        self.assertIsNone(images.unavailable(FakeDocker()))

    def test_no_docker_on_path_is_the_same_sentence_rather_than_a_traceback(self) -> None:
        def missing(argv: list[str], timeout_s: float = 0.0, stream: Any = None) -> Completed:
            raise ImageError("docker_missing", "no `docker` on PATH; a live trial runs inside a container")

        self.assertIn("no `docker` on PATH", str(images.unavailable(missing)))


if __name__ == "__main__":
    unittest.main()
