---
'tenjin-cli': patch
---

A DeepSeek worker's Claude Code now gets the start-up time native Claude Code gives an MCP server (`MCP_TIMEOUT`, 30 seconds by default) instead of a fixed 10 seconds, so a worker on a busy machine starts instead of failing after its offer's routing fee was paid. A worker that still does not start reports `not_started` and tells the parent to keep the work native by sending the original call again unchanged, which costs no second routing fee. Charges, quotes and settlement are unchanged.
