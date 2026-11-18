---
'tenjin-cli': patch
---

A DeepSeek worker no longer sees Tenjin's own tools under a second registration of Tenjin's server. A machine that still had the older settings install beside the plugin gave a worker `mcp__x402__subagent` and `mcp__x402__request`; each call was refused, but the tools were listed. A Tenjin server that starts inside a worker now lists only the tool its hooks call, whatever name it is registered under, and the worker's Claude Code is given none of Tenjin's tools under the plugin's name or the settings install's.
