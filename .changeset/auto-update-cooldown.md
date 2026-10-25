---
'tenjin-cli': patch
---

The background auto-update now takes a release only once npm published it at least a day ago, so a bad release can be pulled before any machine runs it on its own; until then it switches nothing and `tenjin doctor` says why it waited. A manual `tenjin update` still takes the newest release right away.
