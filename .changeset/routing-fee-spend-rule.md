---
'tenjin-cli': patch
---

The routing fee is the spend and its deposit is channel funding. Each $0.003 fee
is reserved against `maxAutoSpend`, the daily `sessionBudget` (a 0 refuses it) and
`allowlistCreators` before the wallet unlocks, and counts against the day as it is
paid, including a fee from a channel that is already funded. A deposit stays yours
until spent: it is bounded by `maxAutoSpend`, `allowlistCreators` and the wallet's
balance, and the daily limit does not count it. A fee the budget refuses takes the
free path and leaves the deposit in the channel for the next window. A voucher the
SDK retries after a corrective 402 is reserved again first, and a retry the budget
refuses is not sent.

A routing call that carries the channel's deposit now gets 4.5 s instead of 3.5 s,
so the first paid call on a new channel usually returns its answer. A routing
payment still out when the call's time ends no longer shows "the routing payment
failed": that prompt runs on the native tools while `tenjin mcp` lets the request
finish, so the channel records the deposit and the spend ledger records the fee.
