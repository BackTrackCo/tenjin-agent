---
'tenjin-cli': patch
---

The router never blocks a native call any more. WebSearch and WebFetch run
under your own permission rules, and only when one comes back short (a failed
call, a blocked or failing page, an empty page, a search with no results) is a paid
lookup offered after it; a result that is fine makes no router call at all. A
new `PreToolUse` hook on `Agent|Task` routes each subagent's task before it
starts and appends a fitting offer to it as one optional line, and a subagent's
own native calls are routed on its own task. A subagent is only offered lookups
your spend policy would pay without asking, since it cannot ask you to approve
one. Every line the router adds opens with `Tenjin router (installed by the user):`
and names the call by the tool name Claude Code shows, `mcp__x402__request`.
Existing installs keep working as they are: the old `tenjin hook native`
entry is now a no-op, and `tenjin install --refresh` (which `tenjin update`
runs) replaces it with the new entries. `tenjin doctor` names any entry that is
missing or stale.
