---
'tenjin-cli': patch
---

Claude subagents use a separate inference payment channel per run when the router supports refunds. When a worker ends, Tenjin returns unused USDC to its funding wallet and retries pending refunds during the session and after restart. `tenjin balance` shows pending and completed refunds. A router that answers the question about refunds with anything but its refund terms is treated as one without refunds, and the job runs; only no answer, a rate limit or a server error is asked again. After a change of router address, `tenjin balance` and `tenjin status` list the refunds still pending at the earlier router; they are retried only while that router is the configured one.

Inference channels refill as needed with deposits of up to $0.25. When an individual quote requires a larger refill, Tenjin deposits the exact shortfall within the existing spend limits.
