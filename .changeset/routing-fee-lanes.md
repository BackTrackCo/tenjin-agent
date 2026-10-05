---
'tenjin-cli': patch
---

The client side of the routing fee, off until you approve it and Tenjin's server
answers its paid routing path. Each routing call then costs a flat $0.003 over x402
`batch-settlement`, paid from small prepaid lanes: `tenjin mcp` funds each lane with a
$0.25 deposit through the funding path inside your spend limits, pre-signs ten
vouchers per lane with a local voucher key, and recovers a lane after a corrective
402 with the SDK's channel recovery. A hook only claims a lane for ten seconds, sends
its next voucher and writes back the charged total; with no lane free, the call skips
routing and the native tool runs. `routingFee` (approved or declined, which
`tenjin update` asks once) and `routingAllowance` ($0.50 a rolling day) are new config
keys. `tenjin doctor` and the first hook of each session say when routing is paused,
why, and the command that fixes it; `tenjin status` and the new `tenjin payments fees`
show what the fee has cost. Until both conditions hold, routing uses the free path
exactly as before.
