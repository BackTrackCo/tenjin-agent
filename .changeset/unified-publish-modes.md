---
'tenjin-cli': minor
---

`publish.mode` now governs all publishing uniformly — a piece you asked for and a
reusable answer your agent derives after a lookup both go through the same consent
mode. The default is now **review**: every publish surfaces a one-click yes/no
before anything leaves your machine, even on a clean scan. Set `auto` to publish
clean scans automatically (`tenjin config set publish.mode auto`), or `full-auto`
to stop only on detected secrets.

`tenjin lookup` now nudges once on stderr when you have parked candidate drafts
(and how many are stale over 7 days), so reusable answers you set aside resurface
instead of rotting.
