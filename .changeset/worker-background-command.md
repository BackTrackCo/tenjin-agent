---
'tenjin-cli': patch
---

A DeepSeek worker whose command runs in the background no longer ends as unknown. The run stays open while the command runs, its result is the worker's last report, and the follow-up handle stays usable.
