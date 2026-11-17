---
'tenjin-cli': patch
---

Every subagent call can now get its own DeepSeek offer: several calls in one response, calls made while other offers are open or other workers run, calls in a turn a task notification started, and calls for a custom agent type whose definition pins no model. Each offer pays its own routing fee, within your spend limits and each job's ceiling. Cancelling one offer no longer stops later offers in the same turn. `tenjin config subagents why` lists why recent calls got no offer.
