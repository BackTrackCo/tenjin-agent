---
'tenjin-cli': patch
---

The update machinery reads the `latest` dist-tag and nothing else.

`tenjin update`, `tenjin update --check`, and the daily check all resolve against
`latest`, prerelease build or stable, which is the one tag this package's
pipeline moves on every publish. Consulting a second tag as well added no
reachable version and one way to be wrong: a tag sitting ahead of `latest` could
redirect the self-update install to a build the release line never promoted.

A `latest` this build cannot read is now reported as what it is. `tenjin update`
distinguishes a missing tag from a tag naming a version it cannot parse, since
npm does have a build in the second case and the fix is to install it by name.
The daily check records that it asked in both cases, so an unreadable answer
costs one registry request per day rather than one per command. A version string
this package cannot parse still follows no tag at all, which keeps the check
quiet and has `tenjin update` refuse rather than report a foreign build up to
date.
