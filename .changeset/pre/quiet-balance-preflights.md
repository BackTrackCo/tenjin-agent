---
'tenjin-cli': patch
---

Paid calls no longer read your balance first, except once just before Tenjin tops up its routing balance; a fee that balance already covers reads none. When your balance is too low, the call says so. `tenjin balance`, `tenjin status` and `tenjin doctor` still show your balance.
