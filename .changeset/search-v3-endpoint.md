---
'tenjin-cli': patch
---

Search now speaks schemaVersion 3 to `POST /api/search` with
`view: "decision"`. `POST /api/agent/search` is a deprecated alias that answers
410 after one deprecation window (BackTrackCo/tenjin#137), so nothing in the CLI
still calls it: not `tenjin search`, not the MCP `tenjin_search` tool, and not
the WebSearch/dispatch hook scripts `tenjin install` writes.

The v3 request is not the v2 request with a new path. `question` becomes the
documented `query`, `view` is named explicitly rather than left to the server
default, and `freshWithin`/`maxPrice`/`appliesTo` move under a nested `filters`
object. That nesting matters: the v3 route STRIPS an unknown top-level key into
a non-fatal `warnings` array instead of rejecting it, so a top-level `maxPrice`
would have run the search unfiltered with no error anywhere.

The response envelope changed with it. `decision` + `candidates[]` became
`matched` + `items[]`, and the MISS `browse[]` tail is gone — the decision view
draws no fallback shelf, so a miss is an empty result plus a `hint` pointing at
`GET /api/articles`. `--json` carries the server's envelope verbatim, so an
agent parsing `decision` or `candidates` must move to `matched` and `items`. The
local search store keeps its CANDIDATES/MISS vocabulary, because `tenjin
outcome` branches on it and older entries carry it; it is derived from whether
anything matched rather than read off a field that no longer exists.

`tenjin doctor`'s search-contract probe looks for `/api/search` in the
deployment's OpenAPI paths. A deploy advertising only the alias now warns, which
is the case the probe exists for.
