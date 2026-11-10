---
'tenjin-cli': patch
---

Remove balance RPC preflights from routing offers, x402 signing and session start. The one balance read left is just before a routing deposit, which is sized from the router's suggested amount, the fee and the per-call limit; a fee the routing balance already covers reads none. The facilitator checks the balance when it verifies the deposit: when it answers that the wallet holds less, that call gets no route and says the wallet is too low, with no retry. `tenjin status`, `tenjin wallet balance` and `tenjin doctor` still read the balance on request.
