---
'tenjin-cli': patch
---

A prompt no longer carries the routing deposit, so a deposit no longer costs a prompt its routing hint. `tenjin mcp` sets funds aside for routing in the background, when it starts and when the channel runs low, one session per wallet at a time. After you fund a low wallet, routing comes back within 2 minutes.
