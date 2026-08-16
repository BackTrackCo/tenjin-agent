---
'tenjin-cli': patch
---

The update machinery follows the `latest` dist-tag for every build.

`tenjin update`, `tenjin update --check`, and the daily nudge all resolve
against `latest` alone, prerelease build or stable. Which tag a publish lands on
is a property of the release pipeline rather than of the version number, and
this pipeline moves `latest` and nothing else, so consulting a second tag only
gave a stale answer a chance to win: `alpha` has sat on 0.1.0-alpha.7 while
every later build shipped on `latest`. A version string this package cannot
parse still follows no tag at all, which keeps the nudge quiet and has
`tenjin update` refuse rather than report a foreign build up to date.
