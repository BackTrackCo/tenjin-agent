---
'tenjin-cli': patch
---

An empty wallet no longer slows every prompt and search. Once a routing call finds the wallet below the routing deposit, the hooks skip the router for ten minutes instead of waiting each time for its 402 and a balance read, and each session is still told once why Tenjin is not routing. `tenjin wallet balance`, or funds `tenjin wallet fund` sees arrive, ends that at once, so the next prompt routes. USDC sent to the wallet any other way is picked up within ten minutes, or by the next `request` lookup, which always checks.
