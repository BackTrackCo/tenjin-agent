---
'tenjin-cli': patch
---

Size the routing deposit so the wallet keeps money for paid tools: a wallet holding $0.50 or more sets aside $0.25 for routing; a smaller one sets aside the router's suggested amount, $0.05 today, and keeps routing until it drops below that, instead of stopping below $0.25. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
