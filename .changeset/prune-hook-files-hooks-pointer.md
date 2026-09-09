---
'tenjin-cli': patch
---

`tenjin doctor --prune` now also removes the retired pre-daemon hook files
`hook-nags.json` and `hook-health.json`, which nothing has read since the loop
database replaced them. Installed search guidance points hook-arm state at bare
`tenjin hooks` instead of a `config get hooks` subtree that never existed.
