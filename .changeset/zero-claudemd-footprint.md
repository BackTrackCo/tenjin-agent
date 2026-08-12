---
'tenjin-cli': minor
---

Take the CLAUDE.md footprint to zero, and give `install` a real reverse.

`tenjin install` no longer writes its pointer line into `~/.claude/CLAUDE.md` or
`AGENTS.md`. A harness loads every skill's frontmatter description at session
start and that is already the trigger surface, so the line was duplicating the
`tenjin-search` description into a file the operator writes their own notes in —
a footprint none of the tools people compare us to leave, and one the WebSearch
hook already covers deterministically. An install that finds an old line now
removes it and says which file it cleaned, so the cleanup reaches existing
machines through the command people already re-run rather than one nobody knows
to run. `--claude-md` and `--no-claude-md` still parse, hidden, as no-ops, so a
pinned script or a released doc does not start failing on an unknown option.

**`tenjin uninstall`** removes exactly what install wrote: the skills, the hook
scripts, our hook entries and permission rules in the harness's settings.json,
and any legacy pointer line. Every removal is gated on OWNERSHIP rather than
path, reusing the rules the writers already use — a hook entry is ours when its
command names one of our script filenames, a skill is ours when its frontmatter
still claims our name, a rule is ours when it is one we wrote — so another tool's
hook, someone else's skill at our path, and a rule you added yourself all survive,
in their original positions. It removes the FILES it shipped rather than the
directories they sit in: a note you left beside a SKILL.md survives, and keeps its
directory, because a directory we only partly own is not ours to delete. It never touches the wallet, the config, the library,
the search ledger, or parked candidates, and it prints that list on every run
including the one that finds nothing: the boundary is the reassurance people are
looking for when they reach for an uninstaller. Idempotent on a half-installed,
already-uninstalled, or never-installed machine.

Both halves of settings.json are edited in a single pass under one
optimistic-concurrency check, rather than a pass for hooks and another for
permissions: Claude Code writes that file too, and two whole-file
read-modify-writes would be two chances to erase an edit that landed underneath
the command.
