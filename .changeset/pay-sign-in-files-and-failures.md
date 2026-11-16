---
'tenjin-cli': patch
---

Paid results behind a seller's sign-in now come back: when a paid run's status URL asks the wallet that paid to sign in, `tenjin pay` and router job polls sign in and pay nothing. They sign only a GET whose challenge matches the responding origin, with the wallet that paid that host. A run paid before this version cannot be collected this way.

`tenjin pay` saves a paid image, sound or PDF to a file (`savedTo`), falling back to the temp folder, then to `bodyBase64`. Large output is no longer cut off at 64 KB, and output lost to a full disk exits nonzero (4 after a payment).

A failed paid call shows the seller's reason and says you were charged only when the chain shows it. A charged payment never reopens its quote. A job polled with another wallet keeps running and names the wallet that paid. `tenjin payments` lists every direct `tenjin pay`. Permit2 payments are refused, so an imported wallet that had approved Permit2 loses that path.
