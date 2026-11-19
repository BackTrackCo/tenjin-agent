---
'tenjin-cli': patch
---

When a DeepSeek offer is accepted, Tenjin now asks the router whether it refunds the run's channel while the accept's own checks run. A worker that was ready no longer waits for that round trip after them.
