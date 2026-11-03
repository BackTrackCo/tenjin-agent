---
'tenjin-cli': minor
---

Separate automatic router limits from mandatory manual payment consent, check Base USDC balance before signing, repair Ultravioleta discovery, and retire the obsolete payment skill.

`maxAutoSpend` and `sessionBudget` limit automatic router purchases only. Zero blocks positive automatic spending; daily `none` removes the automatic daily ceiling. A missing daily limit defaults to $5 both before and after install. Manual `tenjin pay` ignores both configured limits and always requires consent for the quoted transaction, interactively or through `--yes` after explicit user approval. It is never an autonomous workaround for a router refusal. An optional `--max-price`, creator/destination restrictions, supported payment terms and the balance check still apply.

Legacy `bazaarPay` and `confirm` keys are ignored after upgrade, including old `false`/`always` values. Doctor/status warn; install and refresh remove and report them while preserving current router/limit settings and unrelated fields. `config set` rejects the retired keys. No hand edit is required to keep routing operational.

Manual and automatic payments share one ledger and duplicate guard. Manual payments remain in total reporting without consuming automatic budget headroom. Legacy exposure without mode/counter metadata conservatively counts as automatic until the existing window expires.

Missing Bazaar metadata or an unlisted endpoint is an ordinary direct-payment outcome. Only unavailable/incomplete lookups or exact-listing term differences require invocation-scoped `--ignore-warnings`; `--yes` supplies payment consent only. The selected signer's balance is read before signing, with one bounded retry on an unreadable result. Confirmed insufficient funds or persistent read failure refuses and releases the reservation. Router calls retain their advertised-price checks and wire protocol; policy refusals now say “Blocked by spending policy.”

Do not roll back to a config reader that treats zero as unlimited or ignores `none`; preserve the operator's explicit automatic limits when reverting behavior.
