---
'tenjin-cli': minor
---

Rename `tenjin lookup` to `tenjin search`, following the unified search API in
BackTrackCo/tenjin#463. The command, the MCP tool (`tenjin_search`), the outcome
flag (`--search-id`), the candidate flag (`--search-id`), the response field
(`searchId`), the attribution header (`X-Tenjin-Search-Id`), the error code
(`SEARCH_NOT_FOUND`), and the local store all move together; `tenjin lookup` is
gone rather than aliased, so a stale invocation fails loudly instead of drifting.

A `MISS` can now carry a `browse` tail: at most three unscored pointers
(`resourceId`, `url`, `title`, `price`, `creator.handle`) into the broad
discoverable corpus, rendered as one human hint line with each pointer's price
in dollars (the `--json` envelope keeps the exact atomic value) and kept out of
`candidates` and out of the local store.
