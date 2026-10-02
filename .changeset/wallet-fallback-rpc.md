---
'tenjin-cli': patch
---

A wallet balance read that fails on Base's default RPC now tries two public
ones, `https://base-rpc.publicnode.com` and then `https://base.drpc.org`,
before giving up. The default, mainnet.base.org, rate-limits a busy IP
(`-32016 over rate limit`), and four paid lookups across two research runs were
refused with "the wallet balance could not be read" while those two answered
every read. The fallbacks run only after the default fails, inside the same
timeout: every RPC but the last gets half of what is left, so one that hangs
still leaves the others time. An `rpcUrl` you configured yourself is the only
RPC asked, since choosing one can be about privacy and the public RPCs would
see the wallet's address. The router hooks and `tenjin pay` both read through
it; only the hooks also reuse the minute-long last-known balance.
