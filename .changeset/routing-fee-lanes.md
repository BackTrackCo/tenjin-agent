---
'tenjin-cli': patch
---

The client side of the routing fee, off until you approve it and Tenjin's server
answers its paid routing path. Each routing call then costs a flat $0.003 over x402
`batch-settlement`, paid from small prepaid lanes: `tenjin mcp` funds each lane with a
$0.25 deposit through the funding path (nothing is sent before approval, not even a
probe; a deposit is not a payment, so it counts against neither `maxAutoSpend` nor
`sessionBudget`, and at most 8 lanes hold $2 in all), pre-signs ten
vouchers per lane with a local voucher key kept encrypted like the wallet key, and recovers a lane after a corrective
402 with the SDK's channel recovery. A hook only claims a lane for ten seconds, sends
its next voucher and writes back the charged total; with no lane free, the call skips
routing and the native tool runs. `routingFee` (approved or declined: `tenjin install`
names it in its spend-limit question and approving the limits approves it, and
`tenjin update` asks once when it is still unanswered) and `routingAllowance` ($0.50 a rolling day) are new config
keys. `tenjin doctor` and the first prompt hook of each session say when routing is paused,
why, and the command that fixes it; `tenjin status` and the new `tenjin payments fees`
show what the fee has cost. Until both conditions hold, routing uses the free path
exactly as before.

The `@x402/*` SDK moves to 2.21.0, the server's version. With it, every provider
payment carries Tenjin's builder code in the SDK's own `builder-code` extension, also
to sellers that never asked for one: the SDK's default.
