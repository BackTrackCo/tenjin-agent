---
'tenjin-cli': minor
---

Close the loop's own loop: record whether the agent used what the hooks showed
it, locally and on the shelf that served it.

**`tenjin grade [--since 7d] [--session <id>] [--explain] [--label <uid>
<status>]`.** The arms record what they delivered and the shelf records what it
served; neither can see what happened next, so nothing has ever measured the
loop's precision. This reads the session transcript, finds where the
injection landed, and judges what the agent did after it. Only tool inputs
count: prose agreeing with an injection is what an injection makes likely
whether or not it helped, while a tool call is a decision the agent spent
something on. An explicit `tenjin read|inspect <id>` or the injected URL is
`used` whenever it appears; a two-word backtick span copied out of the injected
text within the next ten tool calls is the weaker `partially_used`; nothing at
all, once the session has ended, is `rejected`; and a finding that was never in
front of the agent — every subagent injection, which reaches no transcript — is
`unobserved`. A session still running is left open rather than called rejected,
because the shelf keeps the first verdict per lookup and post and the next tool
call could contradict it, and so is a session whose transcript this machine
could not go looking for: `unobserved` is permanent, and an unreadable home
directory is a fact about the run rather than about the row. Verdicts go to the
shelf that actually served the row — the origin of the URL it was shown with,
since a search id means nothing on another shelf and that endpoint answers 202
either way — with the team bypass header only when that origin is the configured
team shelf's. A landed verdict is never re-posted and a failed one is retried on
the next run. `--explain` shows the anchor line and the evidence; `--label` sets
one verdict by hand, on an injected row only.

**One store, not two.** `lib/search-store.ts` was a second module over the same
`searches` table, left over from when that ledger was a file. Its helpers move
into the store, and two queries stop scanning on the way: `buy <resourceId>` and read attribution now ask one
statement over `json_each` instead of walking 500 rows' candidate arrays, and a
search is looked up by id case-insensitively rather than filtered out of the
same 500. Behaviour is unchanged, with one break: the `candidate` value is gone
from the resolution vocabulary, where it was retained only so a value written by
an older build would parse.
