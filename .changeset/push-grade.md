---
'tenjin-cli': minor
---

Close the push experiment's own loop: record whether the agent used what the
hooks showed it, locally and on the shelf that served it.

**`tenjin push grade [--since 7d] [--session <id>] [--explain] [--label <uid>
<status>]`.** The arms record what they injected and the shelf records what it
served; neither can see what happened next, so nothing has ever measured the
sidecar's precision. This reads the session transcript, finds where the
injection landed, and judges what the agent did after it. Only tool inputs
count: prose agreeing with an injection is what an injection makes likely
whether or not it helped, while a tool call is a decision the agent spent
something on. An explicit `tenjin read|inspect <id>` or the injected URL is
`used` whenever it appears; a two-word backtick span copied out of the injected
text within the next ten tool calls is the weaker `partially_used`; nothing at
all, once the session has ended, is `rejected`; and a finding no transcript row
names — every subagent injection, which reaches no transcript — is `unobserved`.
A session still running is left open rather than called rejected, because the
shelf keeps the first verdict per lookup and post and the next tool call could
contradict it. Verdicts go to the shelf the row names, a landed one is never
re-posted, and a failed one is retried on the next run. `--explain` shows the
anchor line and the evidence; `--label` sets one verdict by hand.

**`tenjin push status` now says how that went.** Under the existing ledger
tallies, the verdicts per arm and shelf (`used`, `rejected`, `unobserved`,
`ungraded`, `posted`), and under those one `GET /api/lookups/stats?days=7` per
configured shelf — the same window from the shelf's side, summed across every
caller it serves. A shelf that cannot be reached prints `server: unavailable`
rather than zeros, and the local counts still stand: a shelf that is down and a
shelf with no demand are different facts.

**One store, not two.** `lib/search-store.ts` was a second module over the
`searches` table `lib/state-store.ts` already owns, left over from when that
ledger was a file. Its helpers move into the store, and two queries stop
scanning on the way: `buy <resourceId>` and read attribution now ask one
statement over `json_each` instead of walking 500 rows' candidate arrays, and a
search is looked up by id case-insensitively rather than filtered out of the
same 500. Behaviour is unchanged, with one break: the `candidate` value is gone
from the resolution vocabulary, where it was retained only so a value written by
an older build would parse.
