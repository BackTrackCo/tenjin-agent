---
'tenjin-cli': patch
---

Each DeepSeek worker job has its own temp folder, which its commands and file tools can use by path and which is removed when the job ends; the worker is told of it as a native session is told of its scratchpad. Worker commands can no longer read or write other Claude Code sessions' temp files under `/tmp/claude-<uid>`. In bypass mode the read check's ask about a shell command whose paths it cannot work out is now answered, as intended; in auto mode it stays refused, and the refusal tells the worker which form of the command can be judged.
