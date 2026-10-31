---
'tenjin-cli': patch
---

Size the routing deposit so the wallet keeps money for paid tools: each deposit is the router's suggested amount ($0.03 today, $0.05 once the router's update ships), less when the wallet or the per-call limit is smaller, but never less than ten fees ($0.03) or more than $0.25, so a big wallet no longer sets aside $0.25 at once. Routing keeps going until the wallet holds less than ten fees, instead of stopping below $0.25. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
