---
'tenjin-cli': patch
---

Routing has one path: every routing call goes to the paid route. A call the wallet cannot pay is skipped at once, with no second request to the free route, and the person is told why once per session. The free route now serves only browsing the tool list, reading a tool's spec, and outcome reports. The `tenjin hook <kind>` commands that older setups wrote no longer route; each tells the person once per session to ask their agent to set Tenjin up again, and says nothing in a session the Claude Code plugin serves.
