---
'tenjin-cli': patch
---

A router `request` the provider refused now says why. When the provider answers
a non-2xx status, before or after payment, the tool's failure envelope carries
`providerStatus` and `providerError`: the first 500 characters of the provider's
body, redacted and on one plain line, whether or not it is JSON, and marked as
untrusted provider content like the rest of the envelope. Before this, a paid
call Firecrawl answered 403 on reached the agent with neither the status as a
field nor the provider's reason, so a refused target read like an outage.
`tenjin pay` carries the same `providerError` in its error details. Settlement
on a paid failure is still reported as unknown.
