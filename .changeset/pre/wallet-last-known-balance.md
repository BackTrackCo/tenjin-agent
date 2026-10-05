---
'tenjin-cli': patch
---

The router hooks remember a wallet balance read for a minute in
`~/.tenjin/balance.json` (the address and amount only, never the RPC URL) and
reuse it instead of asking the RPC again, so a burst of parallel lookups no
longer runs Base's public RPC into its rate limit or waits on its timeout. A
payment still reads the signer's balance live immediately before signing and
never uses the remembered one.
