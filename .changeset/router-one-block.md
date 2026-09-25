---
'tenjin-cli': patch
---

The pre-call router hook no longer redirects WebSearch or WebFetch twice in a
row to the same kind of lookup. When the `mcp__x402__request` lookup it
redirected to does not come back fulfilled (it failed, stopped to ask, or was
never called), that agent's next call matched to the same kind runs as it is,
while other lookups, and the call after that, are routed as usual; the main
agent and each subagent keep their own record. The redirect's reason tells the
agent it can make its own call again if the lookup does not cover it.
