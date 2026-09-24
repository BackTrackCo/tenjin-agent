---
'tenjin-cli': patch
---

The router never blocks a native call any more. WebSearch and WebFetch are still
routed before each call, as before, but a fitting paid lookup is now a line
beside the call instead of a denial, and the call runs under your own
permission rules. When a call comes back short (a failed call, a blocked or
failing page, an empty page, a search with no results) and nothing was offered
before it, a paid lookup is offered after it. A new `PreToolUse` hook on
`Agent|Task` routes each subagent's task before it starts and appends a fitting
offer to it as one optional line, and a subagent's own native calls are routed
on its own task. A subagent is only offered lookups your spend policy would pay
without asking, since it cannot ask you to approve one, and a custom agent whose
`tools:` leave out `mcp__x402__request` is offered nothing (`tenjin doctor`
names those agents). Every line the router adds opens with
`Tenjin router (installed by the user):` and names the call by the tool name
Claude Code shows, `mcp__x402__request`. Existing installs keep working as they
are; `tenjin install --refresh` (which `tenjin update` runs) adds the new
entries, and `tenjin doctor` names any entry that is missing or stale.
