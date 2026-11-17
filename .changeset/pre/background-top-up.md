---
'tenjin-cli': patch
---

Ordinary routing deposits run in the background. A free routing answer can return while a top-up is in flight; only the paid retry waits for it within the call’s deadline. A per-answer quote above $0.003 can still need an inline deposit on its own call. `tenjin mcp` sets funds aside for routing in the background, when it starts and when the channel runs low, one session per wallet at a time. After you fund a low wallet, routing comes back within 2 minutes.
