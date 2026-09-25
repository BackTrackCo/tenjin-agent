---
'tenjin-cli': minor
---

Replace the payment toggle with explicit spending controls, check Base USDC balance before signing, repair Ultravioleta discovery, and require invocation-scoped acknowledgement of direct-payment registry warnings.

Alpha configuration cutover: remove the retired `bazaarPay` key from your config yourself, then choose `router.enabled`, `maxAutoSpend`, `sessionBudget` and `confirm`. A config containing the old key refuses before installation or payment; installation never erases it or loosens explicit settings. `sessionBudget 0` now refuses positive payments even with `--yes`. Use an explicit amount for the daily limit, or `tenjin config set sessionBudget none` to remove the cumulative ceiling. `maxAutoSpend` is the automatic approval threshold, not a hard ceiling on confirmed manual calls.

Direct payments with missing listings, unavailable/incomplete verification or differing listed terms require `--ignore-warning`; `--yes` alone does not acknowledge them. Warning acknowledgement never bypasses confirmation, price caps, daily limits, balance or destination checks. Router payments retain their existing advertised-price enforcement and wire protocol. Install/refresh removes only owned obsolete payment-skill files.

Do not roll back to a config reader that treats zero as unlimited or ignores the new unlimited value; preserve the operator's settings when reverting behavior.
