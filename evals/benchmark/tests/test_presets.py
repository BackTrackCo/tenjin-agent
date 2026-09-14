"""Named settings presets: nothing an arm runs moved when the block became a name."""

from __future__ import annotations

import contextlib
import copy
import json
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from evals.benchmark import cli, manifest, presets, sha256_json
from evals.benchmark.manifest import ManifestError
from evals.benchmark.presets import PresetError

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


# Every committed manifest expands to exactly the settings it expanded to before.






def test_a_named_preset_and_the_block_it_names_hash_the_same() -> None:
    # Expansion runs before the hash, so naming a preset is not a manifest
    # change: the run comparison a record's `manifest_hash` carries holds
    # across the rewrite.
    preset = presets.settings("generated-hooks")
    with frozen() as base:
        named = manifest.load(written(base, "named.json", {presets.PRESET_KEY: "generated-hooks"}))
        inline = manifest.load(written(base, "inline.json", {"settings": preset}))
    assert named.hash == inline.hash
    assert named.arms[1]["settings"] == preset
    assert presets.PRESET_KEY not in named.arms[1]


def test_an_unknown_preset_is_refused_before_any_spend() -> None:
    with frozen() as base:
        with pytest.raises(ManifestError) as caught:
            manifest.load(written(base, "unknown.json", {presets.PRESET_KEY: "tenjin-hooks"}))
    assert presets.PRESET_KEY in str(caught.value)
    assert "tenjin-hooks" in str(caught.value)
    for name in ("", None, 5, "GENERATED-HOOKS"):
        with pytest.raises(PresetError):
            presets.settings(name)






def test_an_override_merges_objects_and_replaces_anything_else() -> None:
    expanded = presets.expand(
        {
            "arms": [
                {
                    "id": "narrowed",
                    presets.PRESET_KEY: "generated-hooks",
                    "settings": {"permissions": {"allow": ["Bash(tenjin read:*)"]}, "env": {"BENCH_ARM": "narrowed"}},
                }
            ]
        }
    )
    settings = expanded["arms"][0]["settings"]
    assert settings["permissions"] == {"allow": ["Bash(tenjin read:*)"]}
    assert settings["env"] == {"BENCH_ARM": "narrowed"}
    assert "SubagentStop" in settings["hooks"]
    assert presets.PRESET_KEY not in expanded["arms"][0]


def test_a_non_object_override_is_refused() -> None:
    with pytest.raises(PresetError):
        presets.expand({"arms": [{"id": "bad", presets.PRESET_KEY: "generated-hooks", "settings": "on"}]})


def test_expansion_never_mutates_the_package_preset() -> None:
    before = copy.deepcopy(presets.PRESETS)
    expanded = presets.expand({"arms": [{"id": "a", presets.PRESET_KEY: "generated-hooks"}]})
    expanded["arms"][0]["settings"]["permissions"]["allow"].append("Bash(rm:*)")
    expanded["arms"][0]["settings"]["hooks"]["Stop"].clear()
    assert presets.PRESETS == before


@pytest.fixture(autouse=True)
def generated_preset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(presets, "PRESETS", {"generated-hooks": {"permissions": {"allow": ["Bash(tenjin read:*)"]}, "hooks": {"SubagentStop": [{"hooks": []}], "Stop": [{"hooks": []}]}}})
