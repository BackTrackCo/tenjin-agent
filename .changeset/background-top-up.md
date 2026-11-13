---
'tenjin-cli': patch
---

Ordinary routing fees are funded in the background, so their deposits no longer cost a prompt its routing hint. A per-answer quote above $0.003 can still need an inline deposit on its own call. `tenjin mcp` sets funds aside for routing in the background, when it starts and when the channel runs low, one session per wallet at a time. After you fund a low wallet, routing comes back within 2 minutes.
