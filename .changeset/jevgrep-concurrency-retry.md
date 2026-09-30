---
'tenjin-cli': patch
---

Run Jevgrep evaluations 16 in flight instead of 2. Retry a transport failure that happens before any payment is signed, keep searching past one uncertain payment with a bounded count, and stop at the first settlement 402 on a signed request.
