---
'tenjin-cli': patch
---

A routing deposit counts once, against `maxAutoSpend` and the daily `sessionBudget`,
when it leaves the wallet, and the fees paid from it are not counted again. Each fee
still gets the per-payment checks before the wallet unlocks, including a fee from a
channel that is already funded: it must fit `maxAutoSpend` and `allowlistCreators`,
and a `sessionBudget` of 0 refuses every fee and so every deposit.

A routing call that carries the channel's deposit now gets 4.5 s instead of 3.5 s,
so the first paid call on a new channel usually returns its answer. A routing
payment still out when the call's time ends no longer shows "the routing payment
failed": that prompt runs on the native tools while `tenjin mcp` lets the request
finish, so the channel and the spend ledger record it.
