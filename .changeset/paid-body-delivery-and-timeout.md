---
'tenjin-cli': patch
---

Six fixes to paid lookups. A paid body is now always delivered: one that fails
the decision's success rule comes back `unverified` with a caveat naming the
rule it missed, where it used to be refused after the money had moved. The
`request` tool now sends its result once instead of twice, and declares
`anthropic/maxResultSizeChars` of 200,000 so Claude Code keeps a full page read
inline; a larger result is saved by Claude Code itself and the model is handed
the path. A 633,016-character page read used to go past the tool-output limit,
so the model never saw what it paid for. The pre-call hook now denies the main
agent's WebFetch or WebSearch only when the paid lookup would run without
approval; over the cap or past the budget, the free call runs and the
after-call offer still applies, where a deny used to leave the page neither
fetched nor bought. The prompt hook follows the same rule: its hint to call
`request` is shown only when that call would run without approval, where it
used to send the model to a `needs_approval` stop while its free tools would
have answered. `tenjin pay` waits on the paid request for the seller's
advertised `maxTimeoutSeconds`, capped at 120 s and never shorter than
`--timeout`, instead of cutting off a signed payment at the 10 s default; the
unpaid probe keeps `--timeout`. And the Bazaar lane's unlisted and mismatch
refusals now say how to check the listing instead of naming the shelved
`tenjin discover`.
