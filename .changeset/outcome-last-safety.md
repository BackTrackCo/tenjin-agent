---
'tenjin-cli': patch
---

Make `tenjin outcome` show which search it is reporting against, and refuse a
status that search could not have produced.

`--last` binds to the newest local search, so in a session that ran more than one
search it often reports against the wrong one, and the success line echoed only a
uuid, which is not something an agent can check its intent against. The line and
the machine `data` now carry the targeted search's question (truncated to 80
characters, ellipsis included so a cut question cannot read as a shorter one). An
explicit `--search-id` the local store knows about gets the same echo.

`purchase_declined` is now refused, before the request, against a search that
offered nothing to buy, and the error names the search and question it would have
landed on. The other four statuses are coherent against any search and are left
alone: a MISS's browse tail is readable and its free pieces are usable, so `used`
and `partially_used` on a MISS are real reports, and `rejected`/`regenerated` are
exactly what a MISS deserves to record. `search` records how many browse pointers
a result carried (the count only, never the pointers, which stay unrecorded so
`buy <resourceId>` still cannot reach one) so a MISS with a payable tail is
distinguishable from a bare one. Entries written before that field read as
unknown rather than zero, so an upgrade never invents a refusal.
