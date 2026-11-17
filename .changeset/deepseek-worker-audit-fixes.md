---
'tenjin-cli': patch
---

A DeepSeek worker reads a repository's tracked `.claude/settings.json` in its working directories, its own or a nested one, as a native subagent does, with the values of its `env` block replaced by `[env:NAME]` before anything is forwarded; one that cannot be parsed stays unreadable, and none is written. `.claude/settings.local.json` and `.mcp.json` stay closed. The job's GitHub token, or the clearing of your session's tokens for a named worker token, now outranks a GitHub token in your Claude Code settings `env` in the worker's commands, and the worker's settings reach Claude Code in a private file rather than on its command line. A folder that held an env file and stops being listable during a job now stops forwarding with `env_file_unscanned`. A worker request that offers more than the 256 tools the router takes is answered as that request's own error, naming the count, with nothing sent or paid.
