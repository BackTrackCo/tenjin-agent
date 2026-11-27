---
'tenjin-cli': patch
---

Judge the Node that runs the DeepSeek worker, not the terminal's. `tenjin config subagents on` checks Tenjin's own runtime Node on Linux, `tenjin wallet reclaim-subagent-credit` says when this Node cannot take the lock instead of reporting a pending refund, and a held call on a Linux Node that cannot lock keeps its reason in `tenjin config subagents why`.
