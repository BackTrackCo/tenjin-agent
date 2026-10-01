---
'tenjin-cli': patch
---

A wallet balance read that fails on the configured Base RPC now tries two
public ones, `https://base-rpc.publicnode.com` and then `https://base.drpc.org`,
before giving up. The default, mainnet.base.org, rate-limits a busy IP
(`-32016 over rate limit`), and four paid lookups across two research runs were
refused with "the wallet balance could not be read" while those two answered
every read. The configured `rpcUrl` is always asked first, and the fallbacks
only after it fails, inside the same timeout: every RPC but the last gets half
of what is left, so one that hangs still leaves the others time. The router
hooks and `tenjin pay` both read through it, beside the minute-long
last-known balance.
