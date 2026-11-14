---
'tenjin-cli': patch
---

A session left open across two `tenjin update` runs keeps working: `tenjin mcp` marks the runtime version it runs from as in use, so an update's cleanup no longer removes it while the session is open. Before, the session's next paid lookup failed until it was restarted.
