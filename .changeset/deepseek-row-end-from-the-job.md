---
'tenjin-cli': patch
---

A DeepSeek worker's row ends with the job's own word and time. A worker that ran past two minutes could be drawn as `Stopped (… 44m 59s …)` though it completed in 15 minutes: the row had lost its read of the worker and closed at a time limit. It now reads how the job ended from the CLI's record, also after a reload or a resumed session, and says `Outcome not shown here` when no read can tell. The parent's spinner is left to Claude Code while a worker runs, as it is while a native subagent runs: it no longer shows the worker's step. Several offers and several workers at once each have their own row, agent list entry and end line, and a custom agent type gets a row and a viewer like the built-in ones.
