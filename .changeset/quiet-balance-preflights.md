---
'tenjin-cli': patch
---

Remove balance RPC preflights from routing offers, deposits, x402 signing and session start. A routing deposit is sized from the router's suggested amount and the per-call limit, as before, without reading the balance first. The facilitator checks the balance when it verifies the deposit: when it answers that the wallet holds less, that call gets no route and says the wallet is too low, with no retry. `tenjin status`, `tenjin wallet balance` and `tenjin doctor` still read the balance on request.
