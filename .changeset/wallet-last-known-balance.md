---
'tenjin-cli': patch
---

A wallet balance read is remembered for a minute in `~/.tenjin/balance.json`
(the address and amount only, never the RPC URL). A paid lookup whose balance
read fails now uses that last-known balance instead of refusing with "the wallet
balance could not be read; no payment was signed", and the router hooks reuse it
instead of asking the RPC again, so a burst of parallel lookups no longer runs
Base's public RPC into its rate limit or waits on its timeout.
