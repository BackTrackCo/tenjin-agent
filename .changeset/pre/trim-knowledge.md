---
'tenjin-cli': patch
---

The knowledge shelf's settings are gone from `tenjin config`: `publish.mode`,
`publish.defaultPrice`, `publish.ackServerWarnings`, the seven `hooks.*` arms,
`loop.*`, `team.publicFallback`, `publicShelfUrl`, `shelfBypassSecret` and
`evalCohort`, along with team mode. `config get` and `config set` now refuse
them as unknown keys. A config file that still holds any of them keeps
working: they are left in the file and never read. `baseUrl` is the router's
base URL and resolves as before.

The error codes nothing raises any more are gone from the JSON envelope's
`error.code`: `NOT_IMPLEMENTED`, `SEARCH_NOT_FOUND`, `NEEDS_CONFIRMATION`,
`PUBLISH_BLOCKED`, `PUBLISH_FAILED` and `DELETE_FAILED`.
