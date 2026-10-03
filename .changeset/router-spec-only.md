---
'tenjin-cli': patch
---

The `request` tool builds every paid call from a spec it keeps on this machine,
and nothing else. An offer's id with an input whose spec has expired or been
pruned now answers `needs_input` at once, pointing the agent at a fresh
`request({query})`, with no server call and nothing paid; before, it fell
through to a server path that no longer exists. Pairs with the Tenjin router
dropping its server-side binder: tenjin-cli 0.1.0-alpha.21 and older receive no
paid offers and are told to run `tenjin update`.
