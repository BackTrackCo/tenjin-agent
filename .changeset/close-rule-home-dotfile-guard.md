---
'tenjin-cli': patch
---

The close rule's `isTrackedPath` excluded vendor directories and `.env*`, but
not a path under the operator's own home dotfile directories — `~/.claude` and
the like, where this tool's own memory, skills and config live. An edit to one
of those between two runs of an identical failing/passing command (the
`sameCommand` branch, the only route in when an error names no file of its
own) was accepted as the fix, and one such pairing synced a note under
`~/.claude/...memory/...` to the team shelf as though it had fixed an
`ELIFECYCLE` failure (tenjin-agent#268). `cwd`-based project scoping was
considered and rejected — the session's cwd is the same for the failing
command and for an edit made via an absolute path elsewhere, so it cannot
separate the two cases, and it would additionally have rejected a legitimate
fix living in a sibling package of a monorepo the cwd never leaves. A home
dotfile check does both correctly, without a git call or an fs stat.
