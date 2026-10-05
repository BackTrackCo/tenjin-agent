---
'tenjin-cli': minor
---

The hook sidecar: a team shelf, two-shelf search, and a capture loop.

**A team shelf is a second Tenjin deployment, not a new thing to learn.** Point `baseUrl` at
it and set `shelfBypassSecret` to its Vercel protection-bypass secret; that one key is what
turns team mode on. `publish`, `search`, `read`, `inspect` and `buy` all work as they always
did, against a different origin. There are no new commands. Every request to `baseUrl` carries
the bypass header and nothing else ever does — the header is attached from the request URL, in
one place, so it cannot follow a call site's mistaken belief about which shelf it is talking
to. `config get shelfBypassSecret` prints `set` or `unset`, in `--json` too.

**Search asks two shelves, team first.** `publicShelfUrl` (the public marketplace,
consume-only) is the fallback: `tenjin search` and every hook arm query `baseUrl` first, and
only on a miss do they ask the public shelf. Human output labels each block by shelf; `--json`
carries the answering shelf's response plus a `shelves` array naming both legs. `read`,
`inspect` and `buy` accept candidates from either origin, and a `buy` signs its SIWX header for
the shelf the URL is actually on. In public mode there is one shelf and none of this is
visible.

**Publishing to a team shelf is free, and loses the warn tier only.** It goes to `baseUrl`
only, never to the public shelf, with the price defaulting to `0`. The scan's WARN tier is
skipped, except for the two credential checks `secret-assignment` and `hex32-value` and the
injection check `embedded-instruction`: the rest of those warnings ask "is this safe to make
public", and a team shelf is not public, so every one of them fires on exactly the findings the
shelf exists to hold. The three exceptions ask something a private audience does not answer —
is this a live credential, and would this text steer the agent that reads it — and `review` and
`auto` still confirm on them. **The hard secret
block still applies on every shelf**, in every mode, clearable by nothing — a team shelf is a
hosted database with logs and a shared door key. The consent cascade is unchanged as well;
`review` still asks once per note. Clearing `shelfBypassSecret` puts the warn tier back.

**A closed loop reaches the shelf that answered.** Every search entry records the base URL of
the leg that minted its searchId, so `tenjin outcome` posts there rather than to whatever
`baseUrl` currently is, and a `--search-id` the other shelf answered is dropped from the publish
body and left open rather than misfiled on a post row.

**The arms put a finding in front of you without being asked.** Hooks watch for the moments
where an answer is worth more than a search — a failing Bash command, a submitted prompt, a
subagent dispatch, a stuck read/edit loop — and surface a match from whichever shelf answered.
Every decision, delivered or not, is recorded with the shelf it came from. No arm ever cancels
or changes a tool call: each one only adds context beside a call the harness makes anyway.

**Capture closes the loop.** A session that actually did research is asked once, at Stop, to
publish anything durable it settled, with the resolved `publish.mode` named in the ask. The bar
follows the mode: public, durable and rights-clean on the marketplace; "anything a teammate on
this project would want to know" on a team shelf. The ask fires once per session whatever the
agent does with it. Sessions that only read and edited code are never asked, and the arms' own
lookups do not count as research.

`shelfBypassSecret` is unset by default, so an existing install picks up no team shelf until it
opts in.
