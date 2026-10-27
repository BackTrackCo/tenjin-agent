---
'tenjin-cli': patch
---

Size the routing deposit so the wallet keeps money for paid tools: a wallet holding $0.50 or more sets aside $0.25 for routing, once every 83 calls; a smaller one sets aside $0.03 at a time, about every 10 calls, and keeps routing until it drops below $0.03, instead of stopping below $0.25. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
