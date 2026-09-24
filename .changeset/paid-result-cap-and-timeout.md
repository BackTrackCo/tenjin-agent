---
'tenjin-cli': patch
---

Four fixes to paid lookups. The `request` tool now hands the model at most 32 KiB
of a provider's body, cut on a character boundary. A longer body is kept whole in
`results/` under the data directory for a day, and the result ends in
`[truncated at N bytes of M; full body at <path>]`: a 633,016-character page read
went past Claude Code's tool-output limit, so the model never saw what it paid
for. The pre-call hook now denies the main agent's WebFetch or WebSearch only
when the paid lookup would run without approval; over the cap or past the budget, the free call runs
and the after-call offer still applies, where a deny used to leave the page
neither fetched nor bought. `tenjin pay` waits on the paid request for the
seller's advertised `maxTimeoutSeconds`, capped at 120 s and never shorter than
`--timeout`, instead of cutting off a signed payment at the 10 s default; the
unpaid probe keeps `--timeout`. And the Bazaar lane's unlisted and mismatch
refusals now say how to check the listing instead of naming the shelved
`tenjin discover`.
