---
'tenjin-cli': minor
---

`tenjin install` now leaves behind a retrieval-instinct nudge, not just a pointer
to where the skills live. The one line it keeps in AGENTS.md (Codex/shared) tells
the agent to run `tenjin lookup "<question>" --json` before regenerating public
research (version-specific compatibility, integration gotchas, benchmarks, dated
probes), and is honest that the lookup, while free and anonymous, sends the
generalized question text to tenjin.blog. Re-running install upgrades an older line
in place instead of skipping it or appending a duplicate, and the walkthrough
discloses what the nudge does plus how to undo it (delete the marker line).

Claude Code gets the same nudge, opt-in, in `~/.claude/CLAUDE.md`: install asks at
an interactive terminal (disclosing that question text is sent to tenjin.blog), or
writes it non-interactively only when you pass `--claude-md` (`--no-claude-md`
suppresses the question). `--dry-run` prints what would change and writes nothing.
