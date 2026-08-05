---
'tenjin-cli': patch
---

The wired CLI skills now follow the CLI you are running.

Updating the CLI never updated the copies `tenjin install` wrote into
`~/.claude/skills` and `~/.agents/skills`, so an agent went on reading an older
version's instructions until someone re-ran `install`, which nobody does because
nothing tells them to. Every command except `install` now compares the
`tenjin-search` and `tenjin-publish` adapters already in those directories
against the packaged ones and rewrites only the files whose bytes differ, through
the same per-file atomic writer `install` uses.

Presence is the consent: a skill that is not in a directory is never created
there, so the heal only ever refreshes what you installed yourself. The hosted
`tenjin` skill is never touched either, because it mirrors
[tenjin.blog/skills.md](https://tenjin.blog/skills.md) and the copy you have may
well be a newer fetch than this package ships; `install` still replaces it, and
still tells you so. It runs after the command's own output and can neither fail a
command nor change its exit code: a skill it cannot write (a pipe at the path, a
denied directory) is skipped and named in one dim line at a human terminal, and
the rest are healed.

No locks are involved, in either writer. Per-file atomic renames are what make
concurrent installs safe, both writers put the same packaged bytes at the same
paths, and the skills-wiring lock `install` used to take is gone with them.
