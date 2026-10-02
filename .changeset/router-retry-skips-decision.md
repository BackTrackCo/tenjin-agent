---
'tenjin-cli': patch
---

The retry of a WebSearch, WebFetch or question the pre-call router hook already
redirected no longer asks the router. The hook asked first and only then saw the
target was claimed, so every redirect-then-retry pair spent a second routing
decision and left an offer row nobody saw, about 45% of the rows in an active
session. The claim is now checked before the router is asked; two parallel
copies of one call are still denied once.
