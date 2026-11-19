---
'tenjin-cli': patch
---

Let a DeepSeek worker in auto mode run a compound shell command that only reads, such as `cd <dir> && ls` or `cd <worktree> && git status | head`, on macOS and Linux. Claude Code's read check asks about such a command because it cannot work out its paths, and a worker refused it, so workers left folders unread. The command now runs under the shell sandbox, which still refuses a read outside the consented directories. A command that does more than read keeps its refusal with the hint to send the `cd` as its own call, and Windows is unchanged.
