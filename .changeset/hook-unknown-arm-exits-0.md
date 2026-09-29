---
'tenjin-cli': patch
---

`tenjin hook <name>` for a hook arm this binary does not know now exits 0 with
nothing on stdout, the same "no opinion" every handler gives on a bad event.
It used to exit 2 as a usage error, which Claude Code reads as a blocking hook
failure: a settings file written by a newer `tenjin install` (a new arm, or a
source build ahead of the npm release) then failed every call of the matched
tool until the binary caught up.
