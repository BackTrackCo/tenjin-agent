"""The vendored toolchain: one deterministic archive, extracted and verified per trial, platform-pinned."""

from __future__ import annotations

import json
import os
import re
import shutil
import tarfile
from pathlib import Path
from typing import Any, Callable

import pytest

from evals.benchmark import artifact, cli, manifest as manifest_module, vendor
from evals.benchmark.artifact import ArtifactError
from evals.benchmark.manifest import ManifestError
from evals.benchmark.vendor import VendorError

HOST = {"platform": "test-arch", "node_abi": "999"}
OTHER = {"platform": "other-arch", "node_abi": "999"}
ID = "fake-1.0.0-test"

Build = Callable[..., vendor.Vendor]
Rewrite = Callable[..., None]


@pytest.fixture
def base(tmp_path: Path) -> Path:
    return tmp_path / "live"


@pytest.fixture
def fixture(base: Path) -> Path:
    """A tiny installed tree in a temporary fixtures directory, never the real archive."""
    fixture = base / "task"
    tree = fixture / "node_modules"
    (tree / "vitest").mkdir(parents=True)
    (tree / "vitest" / "package.json").write_text('{"name":"vitest","version":"1.0.0"}\n', encoding="utf-8")
    (tree / "vitest" / "vitest.mjs").write_text("console.log('fake')\n", encoding="utf-8")
    (tree / "@scope" / "native").mkdir(parents=True)
    (tree / "@scope" / "native" / "bin").write_bytes(b"\x00binary")
    (tree / "@scope" / "native" / "bin").chmod(0o755)
    (tree / ".bin").mkdir()
    (tree / ".bin" / "vitest").write_text("#!/usr/bin/env node\nimport('../vitest/vitest.mjs');\n", encoding="utf-8")
    (tree / ".modules.yaml").write_text("residue\n", encoding="utf-8")
    (fixture / "package.json").write_text('{"devDependencies":{"vitest":"1.0.0"}}\n', encoding="utf-8")
    (fixture / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    return fixture


@pytest.fixture
def tree(fixture: Path) -> Path:
    return fixture / "node_modules"


@pytest.fixture
def build(base: Path, fixture: Path, tree: Path) -> Build:
    def run(vendor_id: str = ID, host: dict[str, str] = HOST) -> vendor.Vendor:
        return vendor.build(tree, base / vendor.DIR, vendor_id, lock=fixture / "pnpm-lock.yaml", pnpm="11.0.0", host=host)

    return run


@pytest.fixture
def rewrite() -> Rewrite:
    def run(built: vendor.Vendor, **changes: Any) -> None:
        built.path.write_text(json.dumps({**built.record, **changes}), encoding="utf-8")

    return run


def test_the_archive_is_deterministic_and_leaves_out_the_shim_and_pnpm_residue(build: Build, fixture: Path, tree: Path) -> None:
    first = build()
    first_bytes = first.archive.read_bytes()
    os.utime(tree / "vitest" / "vitest.mjs", (1, 1))
    second = build()
    assert second.archive.read_bytes() == first_bytes
    assert first.record["archive_sha256"] == second.record["archive_sha256"]
    with tarfile.open(first.archive, "r:gz") as archive:
        assert sorted(member.name for member in archive.getmembers()) == ["@scope", "@scope/native", "@scope/native/bin", "vitest", "vitest/package.json", "vitest/vitest.mjs"]
        for member in archive.getmembers():
            assert (member.mtime, member.uid, member.gid, member.uname, member.gname) == (vendor.MTIME, 0, 0, "", "")
        assert archive.getmember("@scope/native/bin").mode == 0o755
        assert archive.getmember("vitest/vitest.mjs").mode == 0o644
    assert first.record["files"] == 3
    assert (first.record["vitest"], first.record["platform"], first.record["node_abi"]) == ("1.0.0", "test-arch", "999")
    assert first.record["lock_sha256"] == "sha256:" + vendor.sha256_file(fixture / "pnpm-lock.yaml")


def test_a_link_in_the_tree_is_refused(build: Build, tree: Path) -> None:
    (tree / "vitest" / "link.mjs").symlink_to("vitest.mjs")
    with pytest.raises(VendorError) as caught:
        build()
    assert caught.value.code == "vendor_symlink"


def test_a_tree_without_vitest_is_refused(build: Build, tree: Path) -> None:
    shutil.rmtree(tree / "vitest")
    with pytest.raises(VendorError) as caught:
        build()
    assert caught.value.code == "vendor_source"


def test_the_record_is_checked_for_shape_and_its_archive_for_presence(build: Build, base: Path, rewrite: Rewrite) -> None:
    built = build()
    assert vendor.resolve(base, ID).facts["archive_sha256"] == built.record["archive_sha256"]
    rewrite(built)
    built.archive.unlink()
    with pytest.raises(VendorError) as caught:
        vendor.resolve(base, ID)
    assert caught.value.code == "vendor_archive"


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"extra": 1}, id="unknown key"),
        pytest.param({"platform": ""}, id="empty platform"),
        pytest.param({"files": 0}, id="zero files"),
        pytest.param({"files": True}, id="boolean files"),
        pytest.param({"id": "someone-else"}, id="other id"),
        pytest.param({"archive": "../x.tar.gz"}, id="archive with a path"),
        pytest.param({"archive": "x.zip"}, id="archive not a tarball"),
        pytest.param({"tree_sha256": "abc"}, id="bare digest"),
    ],
)
def test_a_malformed_record_is_refused(build: Build, base: Path, rewrite: Rewrite, changes: dict) -> None:
    rewrite(build(), **changes)
    with pytest.raises(VendorError):
        vendor.resolve(base, ID)


@pytest.mark.parametrize("bad", ("../escape", "a/b", ".hidden", "", "x" * 65))
def test_a_vendor_id_that_is_not_a_bare_name_is_refused(build: Build, base: Path, bad: str) -> None:
    build()
    with pytest.raises(VendorError):
        vendor.resolve(base, bad)


def test_a_missing_record_is_a_refusal_not_a_traceback(base: Path) -> None:
    with pytest.raises(VendorError) as caught:
        vendor.resolve(base, "nothing-here")
    assert caught.value.code == "vendor_record"


def test_extraction_lands_the_tree_and_verifies_it_against_the_record(build: Build, tmp_path: Path) -> None:
    built = build()
    destination = tmp_path / "trial" / "node_modules"
    destination.mkdir(parents=True)
    (destination / ".bin").mkdir()
    (destination / ".bin" / "vitest").write_text("shim\n", encoding="utf-8")
    assert vendor.extract(built, destination, HOST) == 3
    assert (destination / "vitest" / "vitest.mjs").read_text(encoding="utf-8") == "console.log('fake')\n"
    assert os.access(destination / "@scope" / "native" / "bin", os.X_OK)
    assert (destination / ".bin" / "vitest").read_text(encoding="utf-8") == "shim\n"
    assert [path for path in destination.rglob("*") if path.is_symlink()] == []
    assert vendor.read_member(built, "vitest/package.json") == b'{"name":"vitest","version":"1.0.0"}\n'


def test_tampered_archive_bytes_fail_closed(build: Build, tmp_path: Path) -> None:
    built = build()
    built.archive.write_bytes(built.archive.read_bytes() + b"\n")
    with pytest.raises(VendorError) as caught:
        vendor.extract(built, tmp_path / "trial" / "node_modules", HOST)
    assert caught.value.code == "vendor_archive"


@pytest.mark.parametrize("changes", [pytest.param({"tree_sha256": "sha256:" + "0" * 64}, id="recorded tree"), pytest.param({"files": 2}, id="recorded count")])
def test_a_tampered_record_fails_closed(build: Build, base: Path, rewrite: Rewrite, tmp_path: Path, changes: dict) -> None:
    rewrite(build(), **changes)
    with pytest.raises(VendorError) as caught:
        vendor.extract(vendor.resolve(base, ID), tmp_path / "trial" / "node_modules", HOST)
    assert caught.value.code == "vendor_tree"


@pytest.mark.parametrize(("name", "kind"), [("../escape", tarfile.REGTYPE), ("vitest/link", tarfile.SYMTYPE)])
def test_a_member_that_is_a_link_or_escapes_is_refused_before_anything_lands(
    build: Build, base: Path, rewrite: Rewrite, tmp_path: Path, name: str, kind: bytes
) -> None:
    built = build()
    with tarfile.open(built.archive, "w:gz") as archive:
        info = tarfile.TarInfo(name)
        info.type = kind
        info.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
        archive.addfile(info)
    rewrite(built, archive_sha256="sha256:" + vendor.sha256_file(built.archive))
    destination = tmp_path / "trial" / "node_modules"
    with pytest.raises(VendorError) as caught:
        vendor.extract(vendor.resolve(base, ID), destination, HOST)
    assert caught.value.code == "vendor_member"
    assert (list(destination.iterdir()) if destination.exists() else []) == []


@pytest.mark.parametrize(
    ("host", "code"),
    [
        (OTHER, "vendor_platform"),
        ({"platform": "test-arch", "node_abi": "1"}, "vendor_node_abi"),
        ({"platform": "test-arch", "node_abi": None}, "vendor_node_abi"),
    ],
)
def test_another_platform_or_node_abi_is_refused_before_extraction(build: Build, tmp_path: Path, host: dict, code: str) -> None:
    destination = tmp_path / "trial" / "node_modules"
    with pytest.raises(VendorError) as caught:
        vendor.extract(build(), destination, host)
    assert caught.value.code == code
    assert not destination.exists()


def test_matching_is_the_platform_and_the_abi(build: Build) -> None:
    built = build()
    assert vendor.matches(built, HOST)
    assert not vendor.matches(built, OTHER)


def test_the_host_facts_name_this_platform_and_the_node_on_path(build: Build, tmp_path: Path) -> None:
    facts = vendor.host_facts()
    assert facts["platform"] == vendor.host_platform()
    assert re.match(r"^[a-z0-9]+-[A-Za-z0-9_]+$", facts["platform"])
    assert vendor.host_facts({"PATH": str(tmp_path / "empty")})["node_abi"] is None
    assert "node_abi" not in vendor.host_facts(probe_node=False)
    built = build()
    vendor.check_platform(built, {"platform": "test-arch"})
    assert not vendor.matches(built, {"platform": "other-arch"})


def test_trial_roots_carry_the_extracted_tree_beside_the_committed_shim(
    build: Build, base: Path, fixture: Path, tree: Path, rewrite: Rewrite, tmp_path: Path
) -> None:
    built = build(host=vendor.host_facts())
    (tree / ".modules.yaml").unlink()
    roots = artifact.create(tmp_path / "run", "trial-a", fixture, vendor=built)
    assert (roots.repo / "node_modules" / "vitest" / "vitest.mjs").is_file()
    assert (roots.repo / "node_modules" / ".bin" / "vitest").is_file()
    assert not (roots.repo / "node_modules" / ".modules.yaml").exists()
    rewrite(built, platform="other-arch")
    with pytest.raises(ArtifactError) as caught:
        artifact.create(tmp_path / "run", "trial-b", fixture, vendor=vendor.resolve(base, ID))
    assert caught.value.code == "vendor_platform"


@pytest.fixture
def vendored_manifest(build: Build, base: Path, fixture: Path, tree: Path) -> tuple[dict, vendor.Vendor]:
    """The fake manifest, retargeted at the temporary vendored fixture."""
    built = build()
    shutil.rmtree(tree / "vitest")
    shutil.rmtree(tree / "@scope")
    (tree / ".modules.yaml").unlink()
    data = json.loads(cli.FAKE_MANIFEST.read_text(encoding="utf-8"))
    data["tasks"] = [{**data["tasks"][0], "fixture": "task", "vendor": ID, "fixture_hash": manifest_module.fixture_hash(fixture, built)}]
    return data, built


def test_the_fixture_hash_covers_the_fixture_and_the_archive(vendored_manifest, base: Path, fixture: Path) -> None:
    data, _built = vendored_manifest
    manifest_module.validate(data, base)
    assert data["tasks"][0]["fixture_hash"] != manifest_module.fixture_hash(fixture)
    (fixture / "package.json").write_text("{}\n", encoding="utf-8")
    with pytest.raises(ManifestError):
        manifest_module.validate(data, base)
    (fixture / "package.json").write_text('{"devDependencies":{"vitest":"1.0.0"}}\n', encoding="utf-8")
    manifest_module.validate(data, base)


def test_the_fixture_hash_moves_with_the_archive_bytes(vendored_manifest, base: Path) -> None:
    data, built = vendored_manifest
    built.archive.write_bytes(built.archive.read_bytes() + b"\n")
    with pytest.raises(ManifestError) as caught:
        manifest_module.validate(data, base)
    assert "vendor" in str(caught.value)


@pytest.mark.parametrize("vendor_id", [pytest.param("../x", id="vendor id shape"), pytest.param("absent", id="missing vendor")])
def test_an_unusable_vendor_id_refuses_the_manifest(vendored_manifest, base: Path, vendor_id: str) -> None:
    data, _built = vendored_manifest
    with pytest.raises(ManifestError):
        manifest_module.validate({**data, "tasks": [{**data["tasks"][0], "vendor": vendor_id}]}, base)


def test_a_vendored_tasks_hash_is_not_the_bare_directory_hash(vendored_manifest, base: Path, fixture: Path) -> None:
    data, _built = vendored_manifest
    with pytest.raises(ManifestError):
        manifest_module.validate({**data, "tasks": [{**data["tasks"][0], "fixture_hash": manifest_module.fixture_hash(fixture)}]}, base)
