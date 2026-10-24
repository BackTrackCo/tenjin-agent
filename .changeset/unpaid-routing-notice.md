---
'tenjin-cli': patch
---

When the routing fee cannot be paid, the notice and `tenjin doctor` now say Tenjin is not routing calls until it is fixed, instead of saying calls take the free path: the router charges the fee on every call, so an unpaid call gets no routing.
