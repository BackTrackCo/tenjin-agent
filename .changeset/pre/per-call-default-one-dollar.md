---
'tenjin-cli': minor
---

Raise the default per-call spend limit from $0.25 to $1, for every Tenjin tool, where no limit is saved. A saved limit is unchanged. `tenjin config set maxAutoSpend <usd>` now accepts any non-negative USD amount with up to 6 decimal places, including `0`, which stops every automatic payment so that each call asks first.
