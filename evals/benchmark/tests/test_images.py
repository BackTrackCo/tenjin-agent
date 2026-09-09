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
    return images.fixture_labels("actor", fixture_hash, images.recipe(PINS), base_id)


class IdentityTest(unittest.TestCase):
    def test_the_tag_names_the_task_and_the_fixture_hash(self) -> None:
        self.assertEqual(images.fixture_tag("actor", FIXTURE_HASH), "bench2-actor:" + "ab" * 6)

    def test_a_fixture_hash_that_is_not_a_token_is_refused(self) -> None:
        with self.assertRaises(ImageError) as caught:
            images.fixture_tag("actor", "d19a2b57")
        self.assertEqual(caught.exception.code, "fixture_hash")

    def test_the_base_tag_changes_with_the_pinned_harness_version(self) -> None:
        first = images.base_tag(images.recipe(PINS))
        second = images.base_tag(images.recipe({"harness_version": "2.1.264"}))
        self.assertTrue(first.startswith("bench2-base:"))
        self.assertNotEqual(first, second)

    def test_the_base_tag_changes_with_the_dockerfile_and_the_entrypoint(self) -> None:
        """An edit to either is an image change, or a run reuses a stale one.

        On 2026-09-09 the recipe named only versions, so a fix to the trial
        entrypoint left the tag unchanged and two four-attempt runs silently
        used the image built before it.
        """
        base = images.recipe(PINS)
        self.assertIn("dockerfile", base)
        self.assertIn("entrypoint", base)
        for name, path in (("dockerfile", images.BASE_DOCKERFILE), ("entrypoint", images.TRIAL_SCRIPT)):
            self.assertEqual(base[name], images.file_hash(path))
            changed = {**base, name: "sha256:" + "0" * 64}
            self.assertNotEqual(images.base_tag(base), images.base_tag(changed))

    def test_a_recipe_without_a_harness_version_is_refused(self) -> None:
        with self.assertRaises(ImageError) as caught:
            images.recipe({})
        self.assertEqual(caught.exception.code, "recipe_pins")

    def test_the_labels_carry_the_fixture_hash_the_base_and_every_pin(self) -> None:
        labels = labels_for()
        self.assertEqual(labels["bench2.task"], "actor")
        self.assertEqual(labels["bench2.fixture_hash"], FIXTURE_HASH)
        self.assertEqual(labels["bench2.base_id"], "sha256:base")
        self.assertEqual(labels["bench2.claude"], "2.1.263")
        self.assertEqual(labels["bench2.base_digest"], images.BASE_DIGEST)


class RequireTest(unittest.TestCase):
    def test_a_missing_image_names_the_command_that_builds_it(self) -> None:
        docker = FakeDocker({"image inspect": Completed(returncode=1, stdout="", stderr="No such image")})
        with self.assertRaises(ImageError) as caught:
            images.require(TASK, PINS, docker)
        self.assertEqual(caught.exception.code, "image_missing")
        self.assertIn("images build", caught.exception.detail)

    def test_an_image_built_from_another_pin_is_drift_not_a_silent_run(self) -> None:
        stale = {**labels_for(), "bench2.claude": "2.1.200"}
        docker = FakeDocker({"image inspect": inspect_payload(stale)})
        with self.assertRaises(ImageError) as caught:
            images.require(TASK, PINS, docker)
        self.assertEqual(caught.exception.code, "image_drift")
        self.assertIn("2.1.200", caught.exception.detail)

    def test_the_base_id_is_not_compared_because_a_rebuilt_base_is_not_drift(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload(labels_for(base_id="sha256:another"))})
        image = images.require(TASK, PINS, docker)
        self.assertEqual(image.facts["base_id"], "sha256:another")
        self.assertEqual(image.facts["fixture_hash"], FIXTURE_HASH)

    def test_an_unreadable_inspect_is_a_refusal_rather_than_a_crash(self) -> None:
        docker = FakeDocker({"image inspect": Completed(returncode=0, stdout="not json", stderr="")})
        with self.assertRaises(ImageError) as caught:
            images.inspect("bench2-actor:abc", docker)
        self.assertEqual(caught.exception.code, "inspect_unreadable")


class BuildTest(unittest.TestCase):
    def test_the_base_build_passes_every_pin_as_a_build_argument(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload({})})
        images.build_base(images.recipe(PINS), docker)
        arguments = docker.flag(0, "--build-arg")
        self.assertIn(f"BASE_DIGEST={images.BASE_DIGEST}", arguments)
        self.assertIn("CLAUDE_VERSION=2.1.263", arguments)
        self.assertIn(f"PNPM_VERSION={images.PNPM_VERSION}", arguments)
        self.assertEqual(docker.calls[0][-1], str(images.DOCKER_DIR))

    def test_a_fixture_build_uses_the_fixture_directory_as_its_whole_context(self) -> None:
        docker = FakeDocker({"image inspect": inspect_payload(labels_for())})
        base = images.Image(tag="bench2-base:x", id="sha256:base", labels={})
        fixture = Path("/tmp/fixtures/actor")
        images.build_fixture(TASK, fixture, images.recipe(PINS), base, docker)
        argv = docker.calls[0]
        self.assertEqual(argv[-1], str(fixture))
        self.assertIn("--file", argv)
        self.assertEqual(argv[argv.index("--file") + 1], str(images.FIXTURE_DOCKERFILE))
        self.assertIn(f"bench2.fixture_hash={FIXTURE_HASH}", docker.flag(0, "--label"))
        self.assertIn("BASE_TAG=bench2-base:x", docker.flag(0, "--build-arg"))

    def test_a_failed_build_names_the_tag_and_the_exit_code(self) -> None:
        docker = FakeDocker({"build": Completed(returncode=1, stdout="", stderr="boom")})
        with self.assertRaises(ImageError) as caught:
            images.build_base(images.recipe(PINS), docker)
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
                images.recipe(PINS),
                path,
            )
            self.assertEqual(built["recipe"]["claude"], "2.1.263")
            read = images.ledger_read(path)
            self.assertEqual(read["images"]["bench2-actor:abc"]["id"], "sha256:feed")

    def test_a_missing_ledger_reads_as_empty_rather_than_raising(self) -> None:
        self.assertEqual(images.ledger_read(Path("/nonexistent/images.json")), {})


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
