---
'tenjin-cli': patch
---

Claude subagents use a separate inference payment channel per run when the router supports refunds. When a worker ends, Tenjin returns unused USDC to its funding wallet and retries pending refunds during the session and after restart. `tenjin balance` shows pending and completed refunds.

Inference channels refill as needed with deposits of up to $0.25. When an individual quote requires a larger refill, Tenjin deposits the exact shortfall within the existing spend limits.
