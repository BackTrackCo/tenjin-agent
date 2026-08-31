---
'tenjin-cli': patch
---

The close rule's `isTrackedPath` excluded vendor directories and `.env*`, but
not a path under the operator's own home dotfile directories — `~/.claude` and
the like, where this tool's own memory, skills and config live. An edit to one
of those between two runs of an identical failing/passing command was accepted
as the fix, and one such pairing synced a note under `~/.claude/...memory/...`
to the team shelf as though it had fixed an `ELIFECYCLE` failure
(tenjin-agent#268). `isTrackedPath` now excludes home dotfile paths too; see
the code comment on `isHomeDotDirPath` for why `cwd`-based scoping was rejected
in favor of this check.
