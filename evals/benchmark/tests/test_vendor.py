"""The vendored toolchain: one deterministic archive, extracted and verified per trial, platform-pinned."""

from __future__ import annotations

import json
import os
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any

from evals.benchmark import artifact, cli, manifest as manifest_module, vendor
from evals.benchmark.artifact import ArtifactError
from evals.benchmark.manifest import ManifestError
from evals.benchmark.vendor import VendorError

HOST = {"platform": "test-arch", "node_abi": "999"}
OTHER = {"platform": "other-arch", "node_abi": "999"}
ID = "fake-1.0.0-test"


class VendorCase(unittest.TestCase):
    """A tiny installed tree in a temporary fixtures directory, never the real archive."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.base = self.dir / "live"
        self.fixture = self.base / "task"
        self.tree = self.fixture / "node_modules"
        (self.tree / "vitest").mkdir(parents=True)
        (self.tree / "vitest" / "package.json").write_text('{"name":"vitest","version":"1.0.0"}\n', encoding="utf-8")
        (self.tree / "vitest" / "vitest.mjs").write_text("console.log('fake')\n", encoding="utf-8")
        (self.tree / "@scope" / "native").mkdir(parents=True)
        (self.tree / "@scope" / "native" / "bin").write_bytes(b"\x00binary")
        (self.tree / "@scope" / "native" / "bin").chmod(0o755)
        (self.tree / ".bin").mkdir()
        (self.tree / ".bin" / "vitest").write_text("#!/usr/bin/env node\nimport('../vitest/vitest.mjs');\n", encoding="utf-8")
        (self.tree / ".modules.yaml").write_text("residue\n", encoding="utf-8")
        (self.fixture / "package.json").write_text('{"devDependencies":{"vitest":"1.0.0"}}\n', encoding="utf-8")
        (self.fixture / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")

    def build(self, vendor_id: str = ID, host: dict[str, str] = HOST) -> vendor.Vendor:
        return vendor.build(self.tree, self.base / vendor.DIR, vendor_id, lock=self.fixture / "pnpm-lock.yaml", pnpm="11.0.0", host=host)

    def rewrite(self, built: vendor.Vendor, **changes: Any) -> None:
        built.path.write_text(json.dumps({**built.record, **changes}), encoding="utf-8")


class BuildTest(VendorCase):
    def test_the_archive_is_deterministic_and_leaves_out_the_shim_and_pnpm_residue(self) -> None:
        first = self.build()
        first_bytes = first.archive.read_bytes()
        os.utime(self.tree / "vitest" / "vitest.mjs", (1, 1))
        second = self.build()
        self.assertEqual(second.archive.read_bytes(), first_bytes)
        self.assertEqual(first.record["archive_sha256"], second.record["archive_sha256"])
        with tarfile.open(first.archive, "r:gz") as archive:
            names = sorted(member.name for member in archive.getmembers())
            self.assertEqual(names, ["@scope", "@scope/native", "@scope/native/bin", "vitest", "vitest/package.json", "vitest/vitest.mjs"])
            for member in archive.getmembers():
                self.assertEqual((member.mtime, member.uid, member.gid, member.uname, member.gname), (vendor.MTIME, 0, 0, "", ""))
            self.assertEqual(archive.getmember("@scope/native/bin").mode, 0o755)
            self.assertEqual(archive.getmember("vitest/vitest.mjs").mode, 0o644)
        self.assertEqual(first.record["files"], 3)
        self.assertEqual((first.record["vitest"], first.record["platform"], first.record["node_abi"]), ("1.0.0", "test-arch", "999"))
        self.assertEqual(first.record["lock_sha256"], "sha256:" + vendor.sha256_file(self.fixture / "pnpm-lock.yaml"))

    def test_a_link_in_the_tree_is_refused(self) -> None:
        (self.tree / "vitest" / "link.mjs").symlink_to("vitest.mjs")
        with self.assertRaises(VendorError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "vendor_symlink")

    def test_a_tree_without_vitest_is_refused(self) -> None:
        shutil.rmtree(self.tree / "vitest")
        with self.assertRaises(VendorError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "vendor_source")


class ResolveTest(VendorCase):
    def test_the_record_is_checked_for_shape_and_its_archive_for_presence(self) -> None:
        built = self.build()
        self.assertEqual(vendor.resolve(self.base, ID).facts["archive_sha256"], built.record["archive_sha256"])
        cases = {
            "unknown key": {"extra": 1},
            "empty platform": {"platform": ""},
            "zero files": {"files": 0},
            "boolean files": {"files": True},
            "other id": {"id": "someone-else"},
            "archive with a path": {"archive": "../x.tar.gz"},
            "archive not a tarball": {"archive": "x.zip"},
            "bare digest": {"tree_sha256": "abc"},
        }
        for name, changes in cases.items():
            with self.subTest(name), self.assertRaises(VendorError):
                self.rewrite(built, **changes)
                vendor.resolve(self.base, ID)
        for bad in ("../escape", "a/b", ".hidden", "", "x" * 65):
            with self.subTest(id=bad), self.assertRaises(VendorError):
                vendor.resolve(self.base, bad)
        self.rewrite(built)
        built.archive.unlink()
        with self.assertRaises(VendorError) as caught:
            vendor.resolve(self.base, ID)
        self.assertEqual(caught.exception.code, "vendor_archive")

    def test_a_missing_record_is_a_refusal_not_a_traceback(self) -> None:
        with self.assertRaises(VendorError) as caught:
            vendor.resolve(self.base, "nothing-here")
        self.assertEqual(caught.exception.code, "vendor_record")


class ExtractTest(VendorCase):
    def test_extraction_lands_the_tree_and_verifies_it_against_the_record(self) -> None:
        built = self.build()
        destination = self.dir / "trial" / "node_modules"
        destination.mkdir(parents=True)
        (destination / ".bin").mkdir()
        (destination / ".bin" / "vitest").write_text("shim\n", encoding="utf-8")
        self.assertEqual(vendor.extract(built, destination, HOST), 3)
        self.assertEqual((destination / "vitest" / "vitest.mjs").read_text(encoding="utf-8"), "console.log('fake')\n")
        self.assertTrue(os.access(destination / "@scope" / "native" / "bin", os.X_OK))
        self.assertEqual((destination / ".bin" / "vitest").read_text(encoding="utf-8"), "shim\n")
        self.assertEqual([path for path in destination.rglob("*") if path.is_symlink()], [])
        self.assertEqual(vendor.read_member(built, "vitest/package.json"), b'{"name":"vitest","version":"1.0.0"}\n')

    def test_a_tampered_archive_or_record_fails_closed(self) -> None:
        built = self.build()
        destination = self.dir / "trial" / "node_modules"
        with self.subTest("archive bytes"):
            original = built.archive.read_bytes()
            built.archive.write_bytes(original + b"\n")
            with self.assertRaises(VendorError) as caught:
                vendor.extract(built, destination, HOST)
            self.assertEqual(caught.exception.code, "vendor_archive")
            built.archive.write_bytes(original)
        with self.subTest("recorded tree"):
            self.rewrite(built, tree_sha256="sha256:" + "0" * 64)
            with self.assertRaises(VendorError) as caught:
                vendor.extract(vendor.resolve(self.base, ID), destination, HOST)
            self.assertEqual(caught.exception.code, "vendor_tree")
        with self.subTest("recorded count"):
            self.rewrite(built, files=2)
            with self.assertRaises(VendorError) as caught:
                vendor.extract(vendor.resolve(self.base, ID), destination, HOST)
            self.assertEqual(caught.exception.code, "vendor_tree")

    def test_a_member_that_is_a_link_or_escapes_is_refused_before_anything_lands(self) -> None:
        built = self.build()
        for name, kind in (("../escape", tarfile.REGTYPE), ("vitest/link", tarfile.SYMTYPE)):
            with self.subTest(name):
                with tarfile.open(built.archive, "w:gz") as archive:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
                    archive.addfile(info)
                self.rewrite(built, archive_sha256="sha256:" + vendor.sha256_file(built.archive))
                destination = self.dir / f"trial-{kind.decode()}" / "node_modules"
                with self.assertRaises(VendorError) as caught:
                    vendor.extract(vendor.resolve(self.base, ID), destination, HOST)
                self.assertEqual(caught.exception.code, "vendor_member")
                self.assertEqual(list(destination.iterdir()) if destination.exists() else [], [])

    def test_another_platform_or_node_abi_is_refused_before_extraction(self) -> None:
        built = self.build()
        destination = self.dir / "trial" / "node_modules"
        for host, code in ((OTHER, "vendor_platform"), ({"platform": "test-arch", "node_abi": "1"}, "vendor_node_abi"), ({"platform": "test-arch", "node_abi": None}, "vendor_node_abi")):
            with self.subTest(code), self.assertRaises(VendorError) as caught:
                vendor.extract(built, destination, host)
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(destination.exists())
        self.assertTrue(vendor.matches(built, HOST))
        self.assertFalse(vendor.matches(built, OTHER))

    def test_the_host_facts_name_this_platform_and_the_node_on_path(self) -> None:
        facts = vendor.host_facts()
        self.assertEqual(facts["platform"], vendor.host_platform())
        self.assertRegex(facts["platform"], r"^[a-z0-9]+-[A-Za-z0-9_]+$")
        self.assertIsNone(vendor.host_facts({"PATH": str(self.dir / "empty")})["node_abi"])
        self.assertNotIn("node_abi", vendor.host_facts(probe_node=False))
        built = self.build()
        vendor.check_platform(built, {"platform": "test-arch"})
        self.assertFalse(vendor.matches(built, {"platform": "other-arch"}))


class SeamTest(VendorCase):
    def test_trial_roots_carry_the_extracted_tree_beside_the_committed_shim(self) -> None:
        built = self.build(host=vendor.host_facts())
        (self.tree / ".modules.yaml").unlink()
        roots = artifact.create(self.dir / "run", "trial-a", self.fixture, vendor=built)
        self.assertTrue((roots.repo / "node_modules" / "vitest" / "vitest.mjs").is_file())
        self.assertTrue((roots.repo / "node_modules" / ".bin" / "vitest").is_file())
        self.assertFalse((roots.repo / "node_modules" / ".modules.yaml").exists())
        self.rewrite(built, platform="other-arch")
        with self.assertRaises(ArtifactError) as caught:
            artifact.create(self.dir / "run", "trial-b", self.fixture, vendor=vendor.resolve(self.base, ID))
        self.assertEqual(caught.exception.code, "vendor_platform")

    def test_the_fixture_hash_covers_the_fixture_and_the_archive(self) -> None:
        built = self.build()
        shutil.rmtree(self.tree / "vitest")
        shutil.rmtree(self.tree / "@scope")
        (self.tree / ".modules.yaml").unlink()
        data = json.loads(cli.FAKE_MANIFEST.read_text(encoding="utf-8"))
        task = {**data["tasks"][0], "fixture": "task", "vendor": ID, "fixture_hash": manifest_module.fixture_hash(self.fixture, built)}
        data["tasks"] = [task]
        manifest_module.validate(data, self.base)
        self.assertNotEqual(task["fixture_hash"], manifest_module.fixture_hash(self.fixture))
        with self.subTest("fixture bytes"):
            (self.fixture / "package.json").write_text("{}\n", encoding="utf-8")
            with self.assertRaises(ManifestError):
                manifest_module.validate(data, self.base)
            (self.fixture / "package.json").write_text('{"devDependencies":{"vitest":"1.0.0"}}\n', encoding="utf-8")
            manifest_module.validate(data, self.base)
        with self.subTest("archive bytes"):
            original = built.archive.read_bytes()
            built.archive.write_bytes(original + b"\n")
            with self.assertRaises(ManifestError) as caught:
                manifest_module.validate(data, self.base)
            self.assertIn("vendor", str(caught.exception))
            built.archive.write_bytes(original)
        with self.subTest("vendor id shape"):
            with self.assertRaises(ManifestError):
                manifest_module.validate({**data, "tasks": [{**task, "vendor": "../x"}]}, self.base)
        with self.subTest("missing vendor"):
            with self.assertRaises(ManifestError) as caught:
                manifest_module.validate({**data, "tasks": [{**task, "vendor": "absent"}]}, self.base)
            self.assertIn("vendor", str(caught.exception))
        with self.subTest("a vendored task's hash is not the bare directory hash"):
            with self.assertRaises(ManifestError):
                manifest_module.validate({**data, "tasks": [{**task, "fixture_hash": manifest_module.fixture_hash(self.fixture)}]}, self.base)

    def test_the_live_manifests_name_the_one_archive_and_its_record_agrees_with_the_fixture(self) -> None:
        manifest = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)
        ids = {task["vendor"] for task in manifest.tasks}
        self.assertEqual(len(ids), 1)
        built = manifest.vendor_for(manifest.tasks[0])
        assert built is not None
        self.assertEqual(built.archive.parent.name, vendor.DIR)
        self.assertLess(built.archive.stat().st_size, 10 << 20)
        self.assertEqual(built.record["platform"], "darwin-arm64")
        self.assertEqual(built.record["node_abi"], "137")
        for task in manifest.tasks:
            fixture = manifest.fixture_path(task)
            self.assertEqual(built.record["lock_sha256"], "sha256:" + vendor.sha256_file(fixture / "pnpm-lock.yaml"))
            self.assertEqual([path.name for path in (fixture / "node_modules").iterdir()], [".bin"])
        smoke = manifest_module.load(cli.SMOKE_MANIFEST)
        self.assertIsNone(smoke.vendor_for(smoke.tasks[0]))


if __name__ == "__main__":
    unittest.main()
