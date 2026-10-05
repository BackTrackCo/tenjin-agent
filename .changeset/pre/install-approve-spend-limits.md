---
'tenjin-cli': patch
---

`tenjin install` in an interactive terminal now asks once, before it writes
anything, whether to use the automatic spend limits ($0.25 a call, $5 a day) or
set your own. Your own limits must be above zero, and the daily limit may be
`none`. Cancelling writes nothing. A limit already in the config file is kept
and not asked for. Non-interactive runs, `--json`, and `--refresh` (which
`tenjin update` runs) ask nothing and write the defaults only where the file
names no limit, as before.
