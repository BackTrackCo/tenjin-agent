---
'tenjin-cli': patch
---

Router hooks are now safe inside subagents. WebSearch and WebFetch are routed
before each call as before, and a fitting paid lookup still redirects the call
to `mcp__x402__request`; but a subagent is redirected only when it is known to
have `mcp__x402__request` (its own `tools:`, or the built-in `general-purpose`,
`Explore` and `Plan` agents) and your spend policy would pay without asking, and
it is routed on its own task rather than the parent's last message. When a free
call clearly fails (blocked, a server error, an empty page, a search with no
links, a network error; never a 404 or 410), the router is asked once and may
offer a paid lookup. A new `PreToolUse` hook on `Agent|Task` appends a fitting
offer to the task a subagent is handed. Every line the router adds opens with
`Tenjin router (installed by the user):` and names the call
`mcp__x402__request`. `tenjin doctor` names custom agents whose `tools:` leave
the paid tool out. Existing installs keep working as they are;
`tenjin install --refresh` (which `tenjin update` runs) adds the new hooks.
