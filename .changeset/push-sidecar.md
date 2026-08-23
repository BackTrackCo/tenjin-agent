---
'tenjin-cli': minor
---

The push sidecar: a team shelf, two-shelf search, and a capture loop — all off by default.

**A team shelf is a second Tenjin deployment, not a new thing to learn.** Point `baseUrl` at
it and set `shelfBypassSecret` to its Vercel protection-bypass secret; that one key is what
turns team mode on. `publish`, `search`, `read`, `inspect` and `buy` all work as they always
did, against a different origin. There are no new commands. Every request to `baseUrl` carries
the bypass header and nothing else ever does — the header is attached from the request URL, in
one place, so it cannot follow a call site's mistaken belief about which shelf it is talking
to. `config get shelfBypassSecret` prints `set` or `unset`, in `--json` too.

**Search asks two shelves, team first.** `publicShelfUrl` (the public marketplace,
consume-only) is the fallback: `tenjin search` and every push hook query `baseUrl` first, and
only on a miss do they ask the public shelf. Human output labels each block by shelf; `--json`
carries the answering shelf's response plus a `shelves` array naming both legs. `read`,
`inspect` and `buy` accept candidates from either origin, and a `buy` signs its SIWX header for
the shelf the URL is actually on. In public mode there is one shelf and none of this is
visible.

**Publishing to a team shelf is free, and loses the warn tier only.** It goes to `baseUrl`
only, never to the public shelf, with the price defaulting to `0`. The scan's WARN tier is
skipped: those warnings ask "is this safe to make public", and a team shelf is not public, so
every one of them fires on exactly the findings the shelf exists to hold. **The hard secret
block still applies on every shelf**, in every mode, clearable by nothing — a team shelf is a
hosted database with logs and a shared door key. The consent cascade is unchanged as well;
`review` still asks once per note. Clearing `shelfBypassSecret` puts the warn tier back.

**Push puts a finding in front of you without being asked.** With `hooks.push=on`, four hook
scripts watch for the moments where an answer is worth more than a search — a failing Bash
command, a submitted prompt, a subagent dispatch, a stuck read/edit loop — and surface a match
from whichever shelf answered. `tenjin push on|off` toggles the key and wires or leaves the
scripts, and every decision, injected or not, appends one row to `push-ledger.jsonl` carrying
the shelf it came from.

One of those arms can cancel a tool call. On a strong hit on a FREE piece, the hook in front of
`WebSearch`/`WebFetch` may deny that call and hand the finding back in its place
(abort-and-answer) instead of letting the search run — the only hook this CLI writes that ever
changes what the harness does. Every other arm only adds context beside a call that has already
run. `tenjin install` and `tenjin push on` both say so before wiring anything, and every deny
is in the ledger with the query and the piece.

**Capture closes the loop.** With `hooks.capture=block|nudge`, a session that actually did
research is asked once, at Stop, to publish anything durable it settled, with the resolved
`publish.mode` named in the ask. The bar follows the mode: public, durable and rights-clean on
the marketplace; "anything a teammate on this project would want to know" on a team shelf. The
ask fires once per session whatever the agent does with it, and while capture is on it replaces
the open-loop MISS reminder rather than stacking a third publish prompt onto one turn end.
Sessions that only read and edited code are never asked, and the sidecar's own lookups do not
count as research.

**`tenjin push status`** reports the mode, both halves of "wired" (scripts on disk and settings
entries registered), and the last seven days of the ledger: rows by trigger and action, by
shelf, how many distinct findings were surfaced, why rows did not inject, denies, and injected
tokens.

`hooks.push`, `hooks.capture` and `shelfBypassSecret` all default to off/unset, so an existing
install picks up nothing here until it opts in.
