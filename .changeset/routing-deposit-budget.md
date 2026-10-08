---
'tenjin-cli': patch
---

A routing call that carries the channel's deposit now gets 4.5 s instead of 3.5 s, so the first paid call on a new channel usually returns its answer. A routing payment still out when the call's time ends no longer shows "the routing payment failed": that prompt runs on the native tools while `tenjin mcp` lets the request finish, so the deposit and the fee are recorded.
