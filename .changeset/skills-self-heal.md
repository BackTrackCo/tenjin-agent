---
'tenjin-cli': patch
---

The wired skills now follow the CLI you are running.

Updating the CLI never updated the copies `tenjin install` wrote into
`~/.claude/skills` and `~/.agents/skills`, so an agent went on reading an older
version's instructions until someone re-ran `install`, which nobody does because
nothing tells them to. Every command except `install` now compares the
skills already in those directories against the packaged ones and rewrites only
the files whose bytes differ, through the same per-file atomic writer `install`
uses.

Presence is the consent: a skill that is not in a directory is never created
there, so the heal only ever refreshes what you installed yourself. It runs after
the command's own output and can neither fail a command nor change its exit code:
a skill it cannot write (a pipe at the path, a denied directory) is skipped and
named in one dim line at a human terminal, the rest are healed, and a second
process healing at the same moment simply skips, because the next command heals
either way.

The skills-wiring lock is gone. It was there to serialize two `install` runs, but
per-file atomic renames are what make concurrent installs safe, and both writers
now put the same packaged bytes at the same paths.
