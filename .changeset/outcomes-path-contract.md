---
'tenjin-cli': patch
---

Post outcome reports to `/api/searches/:id/outcomes`, the path the server now
documents after BackTrackCo/tenjin#616 dropped the `/agent` prefix. The contract
fixture and the live drift pin move with the client, so the scheduled
contract-drift run goes green again.

No fallback: tenjin serves the old `/api/agent/searches/:id/outcomes` spelling as
a real alias onto the same handler for one deprecation window, so both spellings
answer identically today and the pinned path is the one that survives the window.
