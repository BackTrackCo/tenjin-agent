---
'tenjin-cli': patch
---

Eight fixes to paid lookups. A paid body is now always delivered: one that fails
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
have answered. Both, and a subagent's offer, also need the wallet to cover the
price: once the policy allows the spend, the hook reads the wallet's USDC
balance with one `balanceOf` against `rpcUrl`, inside the hook's existing time
budget, and a balance below the price leaves the free call to run. A fresh
install's empty wallet used to get its WebFetch denied and then a refused
payment. A balance that cannot be read leaves the policy to decide, as before.
`tenjin pay` waits on the paid request for the seller's
advertised `maxTimeoutSeconds`, capped at 120 s and never shorter than
`--timeout`, instead of cutting off a signed payment at the 10 s default; the
unpaid probe keeps `--timeout`. The Bazaar lane now looks a resource up
itself: it asks each registry's `/discovery/search` for this URL under the live
`payTo`, and falls back to the `payTo`-filtered list where a registry has no
such search. CDP's list ignores `payTo` and returns the same first page of
about 17,000 listings, so any endpoint no `discover` sweep had stored was
refused as unlisted. And the lane's refusals and the tenjin-pay skill no longer
name the shelved `tenjin discover`.
