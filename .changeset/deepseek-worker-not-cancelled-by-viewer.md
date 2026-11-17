---
'tenjin-cli': patch
---

A DeepSeek worker is no longer cancelled ten minutes after it starts. Claude Code ends a background agent that shows no progress for ten minutes, the worker's viewer agent held one step open for the whole run, and Tenjin took the viewer's end for a person stopping it. The viewer now works in steps of five minutes, and only stopping the worker's agent from the agent list, or the parent's own cancel call, stops a worker. A worker that does not complete now says who or what ended it, in its end line and in its result to the parent.
