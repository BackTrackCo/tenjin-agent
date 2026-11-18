---
'tenjin-cli': patch
---

Claude subagents use a separate inference payment channel per run when the router supports refunds. When a worker ends, Tenjin returns unused USDC to its funding wallet and retries pending refunds during the session and after restart. `tenjin balance` shows pending and completed refunds.
