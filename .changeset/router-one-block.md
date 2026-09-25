---
'tenjin-cli': patch
---

The pre-call router hook no longer blocks WebSearch or WebFetch twice in a row.
When the `mcp__x402__request` lookup it redirected to does not come back
fulfilled (it failed, stopped to ask, or was never called), the next native call
in that session runs as it is, and routing resumes on the call after. The
redirect's reason now tells the agent it can search again if the lookup does not
cover it.
