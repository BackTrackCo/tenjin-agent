---
'tenjin-cli': patch
---

Size the routing deposit to the wallet: the smaller of $0.25 and the balance rounded down to whole routing fees, never below the server's ten-fee hint ($0.03). A funded wallet still deposits once every 83 calls, and a wallet holding less than $0.25 keeps routing until it drops below $0.03, instead of stopping with its balance stuck. Wallet, status, and deposit notices describe unused money as funds set aside for routing, rather than prepaid credits, and label the locally recorded routing balance as an estimate.
