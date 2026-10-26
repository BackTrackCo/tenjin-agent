---
'tenjin-cli': patch
---

Use the stock SDK's suggested routing deposit (currently $0.03) instead of its $0.25 ceiling, so wallets with less than $0.25 can keep routing. Eligibility checks and doctor use the usual deposit size. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
