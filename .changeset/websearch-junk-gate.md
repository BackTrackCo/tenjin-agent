---
'tenjin-cli': minor
---

Stop the WebSearch hook from turning every web search into a publish obligation.
A recorded MISS is a promise: the Stop hook asks the agent to publish it back or
close it, and the server row feeds `/trending`'s questions tier. Most web
searches are not marketplace questions ("Cluely launch video who made it",
"land-book.com website inspiration 2026"), so the ledger filled with demand
nobody has and the nag stopped meaning anything.

A MISS whose query matches one of four narrow patterns (social and news
artifacts, design inspiration, curated-list shopping, stock media) is no longer
written to `~/.tenjin/searches.json`, so it raises no Stop-hook line. It is still
POSTed to `/api/agent/search` exactly as before, so the query still counts as
demand telemetry. A `CANDIDATES` response is always recorded and always hinted
whatever the patterns say: if the marketplace surfaced answers, the question was
marketplace-shaped by definition.

The patterns are conservative on purpose, because the two errors are not
symmetric: missing junk costs one stale line in a batch the agent already skims,
while suppressing a real question costs the finding it would have become. Over
1094 unique real WebSearch queries the four flag 6.2%. The rejected alternative
was a syntactic "operator soup" test (bare `OR`, quoted fragments, `site:`),
which flags 11.3% of the same corpus and takes durable technical questions with
it, `"dvh" caniuse baseline "widely available" 2023 date OR "2024" OR "2025"`
among them.

Hook script version 18. Existing installs keep the v17 behavior until `tenjin
install` is re-run, which rewrites the scripts. No new config key:
`tenjin config set hooks.searchMode off` already disarms the whole hook.
