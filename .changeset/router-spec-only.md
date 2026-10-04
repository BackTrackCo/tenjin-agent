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

When a hook's conversation packet is over its six-message or 16 KiB bound,
the newest assistant reply is kept, so a follow-up such as "the domain you
found" still carries its referent; older replies go first, then the oldest of
the user's messages. A newest reply too large to fit beside the newest user
message is dropped instead, so an early instruction such as "don't use paid
tools" still reaches the router's gate. Past the bound on user messages alone,
the newest of them are kept.
