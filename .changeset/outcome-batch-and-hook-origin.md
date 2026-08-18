---
'tenjin-cli': minor
---

Close a batch of open search loops in one call, and let the WebSearch hook say
which requests are its own.

The hook now leads its `User-Agent` with `tenjin-websearch-hook/<version>`
instead of the CLI product, so a query that rode along with a web search is
separable from a question an agent deliberately looked up. Tenjin attributes a
request to the first `User-Agent` product, so that position is the whole
mechanism: it lands as `client_name` on the search row, and the marketplace's
/trending questions tier filters on that exact name rather than showing readers
queries nobody vetted. A deliberate `tenjin search` is unchanged and still
identifies as `tenjin-cli`. The caller handoff still composes behind whichever
product leads. `tenjin install` rewrites the hook scripts.

`tenjin outcome --search-id` now repeats, reporting one status against every id
named, and `--all-open` closes every open loop the hook recorded, in any
session. Both report per id in the JSON envelope, and both refuse the whole
batch before sending anything if one target's status could not describe its
search. A batch that closed some and failed others says exactly which.

`--all-open` reports `regenerated` and nothing else, and sweeps MISSes only. The
other statuses are claims about what a specific search did for the agent, and a
blanket `used` over queries nobody examined one by one is attribution the
marketplace would be right to trust and wrong to believe. A hook search Tenjin
answered is left alone for the same reason one step further in: that is the
search where a piece may have been bought and read, and `regenerated` would
overwrite the only positive attribution the loop collects. Deliberate searches
are never swept. Both kinds are counted and named in the output, so a blanket
close cannot look more complete than it is.

A batch stops at the first rate limit or transport failure and reports the rest
untouched, rather than spending an agent's outcome budget on requests that will
fail the same way: an open loop is the safe state, and the Stop hook raises it
again.

The Stop hook's end-of-turn reminder now names ONE close command for the whole
batch of hook misses instead of a per-id one. Seventeen open loops meant
seventeen `outcome` calls, which is enough friction that the honest close stops
happening at all.
