---
'tenjin-cli': patch
---

The router never blocks a native call any more. WebSearch and WebFetch always
run, and when a paid lookup fits, it is offered beside the result. A new
`PreToolUse` hook on `Agent|Task` routes each subagent's task before it starts
and appends a fitting offer to it as one optional line; a subagent's own native
calls are routed on its own task. A subagent is only offered lookups at or
below `maxAutoSpend`, since it cannot ask you to approve one. Run
`tenjin install --refresh` (or `tenjin update`) to register the new hook.
