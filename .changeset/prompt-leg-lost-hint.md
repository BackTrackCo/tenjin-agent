---
'tenjin-cli': patch
---

The prompt leg no longer drops a lost hint silently. When the routing decision times out, the router answers 5xx, or it answers `needs_input`, the model gets one attributed line saying a Tenjin service may fit and naming the request tool to call with its own query. A `needs_input` that names missing inputs carries them. A WebSearch or WebFetch that came back short gets the same line in the same cases. `native`, an unreachable router, a 4xx and an unreadable answer stay silent.
