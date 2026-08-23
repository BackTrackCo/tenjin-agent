---
'tenjin-cli': minor
---

The push sidecar: notes, a team shelf, and a capture loop — all off by default.

**Notes are a local, git-syncable team shelf.** `tenjin notes add|list|show|search|rm`
writes plain markdown with flat front matter under `<dataDir>/notes/notes/*.md`, and
`tenjin team init <git-url>` / `tenjin team sync` make that directory a clone the team
shares. Matching is lexical and local: no embeddings, no service, no request. A note
that answers a question is injected whole, because a finding your own team wrote about
your own stack is worth the tokens.

**Push puts a finding in front of you without being asked.** With `hooks.push=on`,
four hook scripts watch for the moments where an answer is worth more than a search —
a failing Bash command, a submitted prompt, a subagent dispatch, a stuck read/edit
loop — and surface a match. The team shelf is consulted first and a hit there makes no
network request at all; only a miss reaches the marketplace. `tenjin push on|off`
toggles the key and wires or leaves the scripts, and every decision, injected or not,
appends one row to `push-ledger.jsonl`.

One of those arms can cancel a tool call. On a strong hit on a FREE piece, the hook in
front of `WebSearch`/`WebFetch` may deny that call and hand the finding back in its
place (abort-and-answer) instead of letting the search run — the only hook this CLI
writes that ever changes what the harness does. Every other arm only adds context
beside a call that has already run. `tenjin install` and `tenjin push on` both say so
before wiring anything, and every deny is in the ledger with the query and the piece.

**Capture closes the loop.** With `hooks.capture=block|nudge`, a session that actually
did research is asked once, at Stop, to write down anything durable it settled;
`tenjin notes add` or `tenjin notes none` answers the ask and clears it. Sessions that
only read and edited code are never asked, and the sidecar's own lookups do not count
as research.

**`tenjin push status`** reports the mode, both halves of "wired" (scripts on disk and
settings entries registered), and the last
seven days of the ledger: rows by trigger and action, by shelf, how many distinct
findings were surfaced, why rows did not inject, denies, and injected tokens.

Both `hooks.push` and `hooks.capture` default to `off`, so an existing install picks up
nothing here until it opts in.
