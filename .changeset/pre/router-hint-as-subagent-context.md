---
'tenjin-cli': patch
---

Stop Claude Code's auto mode from refusing an Agent call the router suggested a tool for. The router's suggestion for a delegated task was appended to the Agent call's prompt, and auto mode refused the call once because a hook had changed its input after the review. In Claude Code the plugin now takes that line off the call and gives it to the subagent as start-up context, which changes no input.
