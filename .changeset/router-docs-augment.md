---
'tenjin-cli': patch
---

The pre-call router hook no longer blocks a WebSearch for the free library docs
lookup: the search runs as written, Context7 docs for the same query are fetched
alongside it, and when found they are added above the search's own results
(nothing changes when none are found). Paid lookups are redirected exactly as
before, and `tenjin install --refresh` gives the after-call hook the 15 second
timeout that wait needs. A provider's own error message, such as the docs
lookup's "no library matched" 404, now reaches the agent from
`mcp__x402__request` instead of a bare status telling it to retry.
