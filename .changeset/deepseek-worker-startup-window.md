---
'tenjin-cli': patch
---

A DeepSeek worker's Claude Code no longer has a start-up window of its own. It takes the time the machine needs to start, as a native subagent does, bounded by the job's 40-minute wall limit and by cancel, so a worker on a busy machine starts instead of failing after its offer's routing fee was paid. A worker still starting when the wall limit passes reports `not_started` and tells the parent to keep the work native by sending the original call again unchanged, which costs no second routing fee. Charges, quotes and settlement are unchanged.
