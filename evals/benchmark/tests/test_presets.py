"""Named settings presets: nothing an arm runs moved when the block became a name."""

from __future__ import annotations

import contextlib
import copy
import json
import shutil
import tempfile
import unittest
from collections.abc import Iterator
from pathlib import Path

from evals.benchmark import cli, manifest, presets, sha256_json
from evals.benchmark.manifest import ManifestError
from evals.benchmark.presets import PresetError

MANIFESTS = (
    cli.FAKE_MANIFEST,
    cli.SMOKE_MANIFEST,
    cli.HOOKS_SMOKE_MANIFEST,
    cli.KEYS_SMOKE_MANIFEST,
    cli.REAL_MANIFEST,
    cli.LOCAL_ARMS_MANIFEST,
    cli.CANARY_MANIFEST,
    *cli.SLICE_MANIFESTS.values(),
)
# The digest of the hook block the manifests inlined before it became a preset.
# It is the `settings_hash` those arms carried then and carry unchanged now, so
# a preset edit that changes what an arm runs fails here by name.
INLINED_HOOK_BLOCK = "sha256:e88581553afac93ea55d673f06ec0cfb7ec91dfc94639352d1c20af5ae64bbbf"


@contextlib.contextmanager
def frozen() -> Iterator[Path]:
    """A temp directory holding the fake manifest and its fixture, so a manifest written there loads."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        shutil.copytree(cli.FAKE_MANIFEST.parent / "repo", root / "repo")
        yield root


def written(base: Path, name: str, arm: dict) -> Path:
    """The fake manifest in `base`, with `arm` merged into its second arm."""
    data = json.loads(cli.FAKE_MANIFEST.read_text(encoding="utf-8"))
    data["arms"][1] = {**data["arms"][1], **arm}
    path = base / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class ExpansionTest(unittest.TestCase):
    """Every committed manifest expands to exactly the settings it expanded to before."""

    def test_every_arm_expands_to_its_own_declared_settings_hash(self) -> None:
        # `settings_hash` is the identity of the treatment in every record and
        # this change edited none of them, so an arm whose expansion hashes to
        # its declared value runs the block it ran before.
        for path in MANIFESTS:
            for arm in manifest.load(path).arms:
                if "settings" not in arm:
                    continue
                with self.subTest(manifest=path.name, arm=arm["id"]):
                    self.assertEqual(arm["settings_hash"], "sha256:" + sha256_json(arm["settings"]))

    def test_the_preset_is_the_block_the_manifests_inlined(self) -> None:
        preset = presets.settings(presets.TENJIN_HOOKS_AND_CLI_READS)
        self.assertEqual("sha256:" + sha256_json(preset), INLINED_HOOK_BLOCK)
        bare = [arm for path in MANIFESTS for arm in manifest.load(path).arms if arm["settings_hash"] == INLINED_HOOK_BLOCK]
        self.assertTrue(bare)
        for arm in bare:
            with self.subTest(arm=arm["id"]):
                self.assertEqual(arm["settings"], preset)

    def test_a_named_preset_and_the_block_it_names_hash_the_same(self) -> None:
        # Expansion runs before the hash, so naming a preset is not a manifest
        # change: the run comparison a record's `manifest_hash` carries holds
        # across the rewrite.
        preset = presets.settings(presets.TENJIN_HOOKS_AND_CLI_READS)
        with frozen() as base:
            named = manifest.load(written(base, "named.json", {presets.PRESET_KEY: presets.TENJIN_HOOKS_AND_CLI_READS}))
            inline = manifest.load(written(base, "inline.json", {"settings": preset}))
        self.assertEqual(named.hash, inline.hash)
        self.assertEqual(named.arms[1]["settings"], preset)
        self.assertNotIn(presets.PRESET_KEY, named.arms[1])

    def test_an_unknown_preset_is_refused_before_any_spend(self) -> None:
        with frozen() as base:
            with self.assertRaises(ManifestError) as caught:
                manifest.load(written(base, "unknown.json", {presets.PRESET_KEY: "tenjin-hooks"}))
        self.assertIn(presets.PRESET_KEY, str(caught.exception))
        self.assertIn("tenjin-hooks", str(caught.exception))
        for name in ("", None, 5, presets.TENJIN_HOOKS_AND_CLI_READS.upper()):
            with self.subTest(name=name), self.assertRaises(PresetError):
                presets.settings(name)

    def test_an_inline_block_still_works_with_no_preset(self) -> None:
        # The one-off arms: a control with nothing set, a marker variable, and
        # the flat arm's lesson files. None names a preset and none moved.
        smoke = manifest.load(cli.SMOKE_MANIFEST).arms
        self.assertEqual(smoke[0]["settings"], {})
        self.assertEqual(smoke[1]["settings"], {"env": {"BENCH1_SMOKE_ARM": "on"}})
        flat = next(arm for arm in manifest.load(cli.LOCAL_ARMS_MANIFEST).arms if arm["id"] == "flat")
        self.assertEqual(sorted(flat["settings"]), ["overlay"])
        data = {"arms": [{"id": "flat", "settings": {"overlay": {"CLAUDE.md": "x"}}}]}
        self.assertEqual(presets.expand(data), data)

    def test_an_inline_block_wins_over_the_preset_key_by_key(self) -> None:
        # The reporter arm is the whole point: its one real difference from the
        # console arm stays in the manifest, on top of a preset both share.
        arms = manifest.load(cli.KEYS_SMOKE_MANIFEST).arms
        console = next(arm for arm in arms if arm["id"] == "tenjin_keyed_console")
        reporter = next(arm for arm in arms if arm["id"] == "tenjin_keyed_reporter")
        self.assertEqual(console["settings"], presets.settings(presets.TENJIN_HOOKS_AND_CLI_READS))
        self.assertNotIn("overlay", console["settings"])
        self.assertEqual(sorted(reporter["settings"]), ["hooks", "overlay", "permissions"])
        self.assertEqual(reporter["settings"]["hooks"], console["settings"]["hooks"])
        self.assertIn("tenjin-vitest-reporter.mjs", reporter["settings"]["overlay"]["vitest.config.mjs"])

    def test_an_override_merges_objects_and_replaces_anything_else(self) -> None:
        expanded = presets.expand(
            {
                "arms": [
                    {
                        "id": "narrowed",
                        presets.PRESET_KEY: presets.TENJIN_HOOKS_AND_CLI_READS,
                        "settings": {"permissions": {"allow": ["Bash(tenjin read:*)"]}, "env": {"BENCH_ARM": "narrowed"}},
                    }
                ]
            }
        )
        settings = expanded["arms"][0]["settings"]
        self.assertEqual(settings["permissions"], {"allow": ["Bash(tenjin read:*)"]})
        self.assertEqual(settings["env"], {"BENCH_ARM": "narrowed"})
        self.assertIn("SubagentStop", settings["hooks"])
        self.assertNotIn(presets.PRESET_KEY, expanded["arms"][0])

    def test_a_non_object_override_is_refused(self) -> None:
        with self.assertRaises(PresetError):
            presets.expand({"arms": [{"id": "bad", presets.PRESET_KEY: presets.TENJIN_HOOKS_AND_CLI_READS, "settings": "on"}]})

    def test_expansion_never_mutates_the_package_preset(self) -> None:
        before = copy.deepcopy(presets.PRESETS)
        expanded = presets.expand({"arms": [{"id": "a", presets.PRESET_KEY: presets.TENJIN_HOOKS_AND_CLI_READS}]})
        expanded["arms"][0]["settings"]["permissions"]["allow"].append("Bash(rm:*)")
        expanded["arms"][0]["settings"]["hooks"]["Stop"].clear()
        self.assertEqual(presets.PRESETS, before)


if __name__ == "__main__":
    unittest.main()
