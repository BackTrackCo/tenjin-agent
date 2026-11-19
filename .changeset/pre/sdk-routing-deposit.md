---
'tenjin-cli': patch
---

Keep routing when the wallet holds less than $0.25, instead of stopping below $0.25. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
