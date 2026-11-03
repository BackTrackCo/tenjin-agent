---
'tenjin-cli': patch
---

One piece can now claim every search it answered.

`tenjin publish --search-id` repeats, up to ten searches per piece. A research
thread fans out into many searchIds — one investigation last month logged ten
MISSes for what was a single question — and until now the piece published back
against one of them while the other nine were closed one at a time as
`regenerated`. That was false twice over: they were not re-derived, they were
answered by the same piece, and MISS-to-publish conversion counted every sibling
of the thread as a failure.

Every named id closes its own local loop with publish attribution, re-linking one
an `outcome` already closed exactly as a single id does today, and the JSON
envelope reports each id separately (`searches`), so an id this machine has never
recorded warns for itself instead of taking the rest down with it. A lone id
keeps the flat `search` field callers already read. Repeats collapse. A `--draft`
still answers nobody and sends no attribution at all.

Before anything is signed, any named search this machine has no record of is
warned about by id. Tenjin accepts or refuses the named searches as one batch, so
a single id it cannot match refuses the whole publish, and that refusal used to
arrive only after the wallet had signed.

On the wire, one id ships as the bare string it has always been, so a
single-search publish is byte-identical to what shipped before; several ship as
an array, which the live post-create takes.
