---
'tenjin-cli': minor
---

`tenjin install` now leaves behind a retrieval-instinct nudge, not just a pointer
to where the skills live. The one line it keeps in AGENTS.md (Codex/shared) tells
the agent to run a free anonymous `tenjin lookup "<question>"` before regenerating
public research (version-specific compatibility, integration gotchas, benchmarks,
dated probes), then points to the installed skills. Re-running install upgrades an
older line in place instead of skipping it or appending a duplicate.

Claude Code gets the same nudge, opt-in, in `~/.claude/CLAUDE.md`: install asks at
an interactive terminal, or writes it non-interactively only when you pass
`--claude-md` (`--no-claude-md` suppresses the question). `--dry-run` prints what
would change and writes nothing.
