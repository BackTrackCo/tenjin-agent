---
'tenjin-cli': patch
---

Treat a wallet file written by a newer `tenjin-cli` as a downgrade rather than a
corruption. `wallet.json` is pinned to a literal schema version, so the day a v3
ships, an older binary reading that file fell through to the generic parse
failure, whose fix text is "move it aside, then run `tenjin wallet create`" —
advice that walks an operator whose only mistake was running an old binary into
abandoning a funded wallet. A higher `schemaVersion` now raises CONTRACT_MISMATCH
(the code the API layer already uses for a version skew across a schema, and not
one an agent recreates a wallet on), names both versions, and points at
`npm i -g tenjin-cli` while saying in as many words not to delete or recreate the
wallet. The version literal is now a shared `WALLET_SCHEMA_VERSION` constant so
the write site and the read guard cannot drift.
