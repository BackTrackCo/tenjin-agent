---
'tenjin-cli': patch
---

The wired CLI skills now follow the CLI you are running.

Updating the CLI never updated the copies `tenjin install` wrote into
`~/.claude/skills` and `~/.agents/skills`, so an agent went on reading an older
version's instructions until someone re-ran `install`, which nobody does because
nothing tells them to. Every `tenjin` command except `install` now compares the
`tenjin-search` and `tenjin-publish` adapters already in those directories
against the packaged ones and rewrites only the files whose bytes differ, through
the same per-file atomic writer `install` uses. (The `tenjin mcp` server is not a
command in that sense and does not heal; the CLI surface is what this covers.)

It writes unattended, so it is deliberately more cautious than the install you
ran on purpose. It creates nothing: a skill that is not already in a directory is
never put there. It rewrites only a regular file whose frontmatter `name:` says
it is the skill in question, so a symlinked SKILL.md is left for `install` to
follow instead of being written through, and a third-party skill sitting at one
of our paths is left alone. It never touches the hosted `tenjin` skill, which
mirrors [tenjin.blog/skills.md](https://tenjin.blog/skills.md) and may well be a
newer fetch than this package ships. An updated file keeps the mode it had.

Every rewrite is announced: one dim stderr line naming the files it wrote. It is
not TTY-gated, because a piped or
agent-driven run is exactly the case that must not have files change in silence,
and stdout is untouched, so a `--json` run still emits exactly one envelope. The
heal runs after the command's own output and can neither fail a command nor
change its exit code; a skill it cannot write is skipped and named.

It stays out of the way when it should: skipped when `CI` is set, skipped when
`TENJIN_NO_SKILL_HEAL=1`, and skipped entirely when the CLI is running from a
source checkout rather than an installed package.

No locks are involved, in either writer. Per-file atomic renames are what make
concurrent installs safe, both writers put the same packaged bytes at the same
paths, and the skills-wiring lock `install` used to take is gone with them.
