---
'tenjin-cli': patch
---

Delete three exports nothing calls, left behind by earlier cutovers:
`hookHealthPath()` (the loop database replaced `hook-health.json`, which
`doctor --prune` now deletes as a retired file), `maskRules()` (its only caller
went with the hook templates), and the `outro()` clack wrapper. Their doc
comments described machinery that no longer exists. No behaviour change: the
package ships a binary, not a library surface.
