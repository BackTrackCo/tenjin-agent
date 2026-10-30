---
'tenjin-cli': patch
---

Remove balance RPC preflights from routing offers, deposits, x402 signing and session start. A routing deposit signs $0.25 first, or the $0.03 hint when the spend limits leave no room for $0.25; when the facilitator answers that the wallet holds less, it signs the hint once more. The funding notice no longer appears at session start: it appears only when both deposits are refused, as "Your Tenjin wallet is near $0", and that call gets no route. `tenjin status` and `tenjin wallet balance` still read the balance on request.
