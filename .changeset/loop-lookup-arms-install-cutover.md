---
'tenjin-cli': minor
---

The lookup arms and the install cutover (PR C of the loop redesign). Claude Code's
hook entries are now **eleven**, written by `tenjin install` as one whole set: nine
POST the harness's own payload to the loop daemon on `127.0.0.1`, and two run the
shim so a daemon is up before the turn's first tool call. Nothing spawns a
generated `.mjs` script any more. Three arms answer over one factory, one search
leg and one delivery: `prompt` (your prompt, before the turn starts), `research`
and `fetch` (a `WebSearch` query, and a `WebFetch`'s url words plus its prompt
head — separate arms with separate claims, so a run of page fetches cannot spend
the search's), and `context` (a package a file you read imports, and the fourth
edit of one file), which stays log-only. The failure, dispatch, subagent, stop and
primer arms land in the next release; until then their entries fire, and the
daemon records each fire and answers with nothing.

**What an agent sees differently.** Every question is masked and nothing else is
stripped, the WebSearch query included — it used to travel raw. A search query is
never condensed (condensing damaged 131 of 184 real ones; `pgvector testcontainer
collation` came out empty), while a prompt still is. A hit is the first of three
candidates the shelf marks `strong`, so a strong rank 2 lands over an un-strong
rank 1, and `confidence` and `corroborated` are no longer read on this side; each
leg row records the shelf's `calibration`, so a lookup whose meaning step never ran
is not mistaken for an empty shelf. A finding arrives **whole** when the shelf
sends a body — free rows carry one, paid rows do not — with no per-session cap on
full bodies and no second request to fetch one; a shelf that sends none yet gives
pointers, as before. The read and churn lookups send the package or the basename as
query text and no `appliesTo` filter, which matched nothing on a shelf where 93 of
106 pieces carry no card. **The client-side rate limit is deleted**: it refused 246
research fires for every 25 that reached an agent, and the runaway guard is the
shelf's own 429, recorded as `rate-server`. The loop keeps two numbers,
`loop.human_wait_ms` and `loop.tool_wait_ms`; `loop.rate_per_min` and `loop.burst`
are gone.

**What an operator does: run `tenjin install`.** That is the whole upgrade.
Install converges rather than merges — it drops every entry of ours, appends the
eleven, and deletes the previous release's eight generated scripts by name — so a
re-run is byte-identical and **`tenjin uninstall` first is not needed**. It brings
a healthy daemon up _before_ it writes `settings.json`, because Claude Code picks
that file up through a watcher and an entry naming a daemon that is not there turns
a live session's next tool call into an `HTTP hook error`; the file is written mode
0600, since it now carries the daemon token as a literal. `tenjin push on|off` is a
config write and nothing else — no wiring step, no re-install, effective on your
next prompt, and it neither adds nor removes an entry. `tenjin update` fetches the
new build and refreshes the profile it ran under; the bundles are the same bytes for
every profile now, so there is nothing to hunt for. `tenjin uninstall` takes the
entries out first, then stops the daemon and removes its files, keeping `loop.db`
beside `state.db`. `tenjin doctor` compares the port the entries name to the daemon
answering `/health`, and warns on a settings file wider than 0600.

**Hermes is gone.** `tenjin install --harness hermes`, its Python plugin and its
native wiring are deleted; nobody used it, and the adapter comes back against the
frozen kernel if anyone ever does. `loop.db` is deleted rather than migrated across
this series, and `tenjin push status`'s 7-day window holds the previous release's
rows until the loop's own reader ships.
