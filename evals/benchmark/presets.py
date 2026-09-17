"""Named settings presets: the block an arm points at instead of inlining it.

An arm's `settings` is its treatment, and most arms run the same one: the
product's hook wiring, byte for byte, ten arms over. Ten copies of a block are
ten chances for two arms to drift apart because somebody edited one of them, and
a reader cannot tell from the manifest whether two arms differ on purpose. So an
arm names a preset, and a difference that is real stays in the manifest as an
override on top of it rather than folded into the preset's own definition.

`settings_preset` names one of `PRESETS`, and an unknown name is refused before
any spend. An arm may carry `settings` beside it, and the inline object wins key
by key: it is merged over the preset, an object under a shared key merges into
the preset's object, and any other value replaces. An arm that names no preset
keeps its inline block exactly as it was.

Expansion runs in `manifest.load`, before validation and before the hash, so the
hash stays over the settings that actually run: two manifests whose arms expand
alike hash alike, and moving a block into a preset moves no hash a record
already carries.
"""

from __future__ import annotations

import copy
from typing import Any

PRESETS: dict[str, dict[str, Any]] = {}

# The arm key that names a preset. It is spent by expansion, so no arm carries
# it into validation, the hash, or a record.
PRESET_KEY = "settings_preset"


class PresetError(ValueError):
    """A manifest that names a preset the package does not define, or overrides one with a non-object."""


def settings(name: Any) -> dict[str, Any]:
    """A private copy of the named preset. An unknown name is a refusal, never a default."""
    if not isinstance(name, str) or name not in PRESETS:
        raise PresetError(f"unknown {PRESET_KEY} {name!r}; the package defines {', '.join(sorted(PRESETS))}")
    return copy.deepcopy(PRESETS[name])


def merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """`override` over `base`, key by key: two objects merge, anything else replaces."""
    merged = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        merged[key] = merge(current, value) if isinstance(current, dict) and isinstance(value, dict) else copy.deepcopy(value)
    return merged


def expand(data: dict[str, Any]) -> dict[str, Any]:
    """The manifest with every arm's named preset expanded into its own `settings`."""
    arms = data.get("arms")
    if not isinstance(arms, list):
        return data
    expanded: list[Any] = []
    for arm in arms:
        if not isinstance(arm, dict) or PRESET_KEY not in arm:
            expanded.append(arm)
            continue
        rest = {key: value for key, value in arm.items() if key != PRESET_KEY}
        inline = rest.get("settings", {})
        if not isinstance(inline, dict):
            raise PresetError(f"arm {arm.get('id')!r} settings must be an object to override a preset")
        rest["settings"] = merge(settings(arm[PRESET_KEY]), inline)
        expanded.append(rest)
    return {**data, "arms": expanded}
