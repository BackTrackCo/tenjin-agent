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

# The two handlers the product's hook wiring uses. `{data_dir}`, `{daemon_url}`,
# and `{daemon_token}` are per-trial placeholders `claude_live.py` resolves at
# launch; the declared `settings_hash` is over the template, so it names the
# treatment once for every trial that runs it.
_SHIM = {"type": "command", "command": 'node "{data_dir}/hooks/tenjin-shim.mjs" --harness claude', "timeout": 5}
_DAEMON = {"type": "http", "url": "{daemon_url}", "headers": {"Authorization": "Bearer {daemon_token}"}, "timeout": 5}

# Named for what it configures: every hook arm the product ships, plus
# permission to run the CLI's read verbs by hand. An arm's `hooks_disabled`
# turns arms off at provision time, and this is the full set it turns them off
# from; `loop_join` reports a hand-run read apart from the hooks' own fires.
TENJIN_HOOKS_AND_CLI_READS = "tenjin-hooks-and-cli-reads"

PRESETS: dict[str, dict[str, Any]] = {
    TENJIN_HOOKS_AND_CLI_READS: {
        "permissions": {"allow": ["Bash(tenjin search:*)", "Bash(tenjin read:*)", "Bash(tenjin inspect:*)"]},
        "hooks": {
            "SessionStart": [{"matcher": "startup|clear|compact", "hooks": [_SHIM]}],
            "UserPromptSubmit": [{"hooks": [_SHIM]}],
            "PreToolUse": [
                {"matcher": "WebSearch|WebFetch", "hooks": [_DAEMON]},
                {"matcher": "Agent|Task", "hooks": [_DAEMON]},
                {"matcher": "Edit|Write|MultiEdit|Bash", "hooks": [_DAEMON]},
            ],
            "PostToolUse": [
                {"matcher": "Bash", "hooks": [_DAEMON]},
                {"matcher": "Read", "hooks": [_DAEMON]},
            ],
            "PostToolUseFailure": [{"matcher": "Bash", "hooks": [_DAEMON]}],
            "SubagentStart": [{"hooks": [_DAEMON]}],
            "SubagentStop": [{"hooks": [_DAEMON]}],
            "Stop": [{"hooks": [_DAEMON]}],
        },
    },
}

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
