---
'tenjin-cli': patch
---

A DeepSeek worker reads your global Claude Code folder as a native subagent can: session transcripts and project memory under `~/.claude/projects`, your prompt history and your `~/.claude/settings.json` and `settings.local.json` are now readable (never writable), beside the skills, plugins, agents, commands and your personal CLAUDE.md it already had. What it reads there, other projects' sessions included, can reach Tenjin and DeepSeek. Every value in a settings `env` block is replaced with `[env:NAME]` before anything is forwarded, also when a command prints it, which was sent as written before. The credentials file, settings backups, `~/.claude.json`, `~/.tenjin`, `~/.ssh` and folders you did not name stay unreadable.
