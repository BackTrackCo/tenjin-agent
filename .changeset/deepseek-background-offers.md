---
'tenjin-cli': patch
---

Offer DeepSeek for background Agent calls in Claude Code. An Agent call with `run_in_background` was always kept native; it now gets an offer like a foreground call. When the parent accepts, the worker runs in the background: the accept returns at once, the worker's row reads `Backgrounded agent` until it ends, and the Tenjin plugin then hands the worker's stored result to the parent as a message that starts a turn when the session is idle. The job's budget, consent checks, cancel and causes of ending are unchanged, the session's end stops the worker, and sending the call again unchanged keeps it native in the background. Calls that set `resume`, `name`, `team_name` or `isolation` still stay native.
