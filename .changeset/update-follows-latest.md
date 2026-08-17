---
'tenjin-cli': patch
---

`tenjin update` and the daily update check read the `latest` dist-tag and nothing
else, which is the one tag every publish moves. A `latest` this build cannot
parse is now reported as that rather than as a missing package, since npm does
have a build in that case and the fix is to install it by name, and it costs one
registry request per day instead of one per command.
