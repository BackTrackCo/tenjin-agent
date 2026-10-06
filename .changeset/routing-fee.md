---
'tenjin-cli': patch
---

The client side of the routing fee, off until you approve it and Tenjin's server
answers its paid routing path. Each routing call then costs a flat $0.003 over x402
`batch-settlement`, paid by `tenjin mcp` with the stock x402 client: the first call of
a channel carries a $0.25 deposit into it (nothing is sent before approval, not even
a probe; a deposit is not a payment, so it counts against neither `maxAutoSpend` nor
`sessionBudget`, and `allowlistCreators` still applies), the SDK keeps the channel in
its own file storage, and recovers it after a corrective 402. A channel is
held only while a routing call is in flight on it, so nearly every call uses the
wallet's first channel and its one deposit; at most 8 calls at once get a channel
each, a call that finds all 8 busy takes the free path and says so, and a replaced
wallet gets channels of its own.

The router's hook entries are now Claude Code `mcp_tool` hooks that call the new
`hook` tool of the session's `x402` server, so every routing step runs in the one
process that holds the wallet; `tenjin install --refresh` (which `tenjin update` runs)
rewrites the older `tenjin hook` command entries into them. Install and refresh also
write `mcp__x402__hook` into `permissions.deny`, which hides that tool from the model
while the hook calls still run, and the tool acts only for its own session's
transcript. `tenjin hook <kind>` stays for hosts with no MCP server, on the free path.

`routingFee` (approved or declined: `tenjin install` names it in its spend-limit
question and approving the limits approves it, and `tenjin update` asks once when it
is still unanswered) and `routingAllowance` ($0.50 a rolling day) are new config
keys. `tenjin doctor` and the first prompt of each session say when routing is
paused, why, and the command that fixes it; `tenjin status` and the new
`tenjin payments fees` show what the fee has cost. Until both conditions hold,
routing uses the free path exactly as before.

The `@x402/*` SDK moves to 2.28.0. With it, every provider payment carries Tenjin's
builder code in the SDK's own `builder-code` extension, also to sellers that never
asked for one, and the SDK's per-payment cap is set to the amount your spend policy
authorized, so a payment you approved above the SDK's $1 default still signs.
