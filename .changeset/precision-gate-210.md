---
'tenjin-cli': minor
---

The push arms trust the marketplace's verdict instead of guessing, and no hook
can cancel a tool call any more.

**The verdict is two server fields, and nothing is scored on the machine.** A hit
is `strong` only when the shelf reports strong identifier, title, or excerpt
evidence for the top candidate (`corroborated`) and does not call its `confidence`
`low`; everything else
is `none`, which shows nothing, is recorded as `weak`, and falls through from the
team shelf to the public one. The local word-overlap scorer is gone whole — the
stopword list, the ratio and margin thresholds, the whole-word floor, the
answer-card confirmation pass and the `moderate` strength with them. It was the
weakest evidence in the system and it behaved like it: probed on one machine,
12 of 12 real injections were wrong matches, and the shelf had called every one
of them `low`. A hook compares forty words of card text; the shelf has the
embeddings, full-body identifiers, and fused retrieval evidence.

**The WebSearch/WebFetch hook injects beside the search and lets it run.** The
abort-and-answer path is deleted. No script this CLI writes emits
`permissionDecision` any more, so the disclosure `install` and `push on` print
says so plainly: every arm only adds context beside the call. `tenjin push
status` no longer reports denies. The fence-and-nonce machinery stays: it guards
every full-body injection — a free marketplace piece, a teammate's team-shelf
note — not only the path that is gone.

**Every hook lookup names its arm.** A `trigger` (`prompt`, `failure`,
`research`, `dispatch`, `subagent`, `read`, `churn`) rides on every search
request, so the marketplace's per-trigger stats can tell one arm's lookups from
another's. The failure, read and churn arms send the package they are about as an
`appliesTo` filter instead of pasting its name in front of the query — one name,
because the marketplace ANDs every value it is given, and the module an import
could not find beats the package manager that ran — which is never itself the
filter, so a `pnpm test` failure that names no module asks unfiltered rather than
asking for a card about `pnpm`.

A pairing this machine closed itself but never re-verified is now recorded with
strength `unverified` rather than no strength at all, so a rollup can tell an
unverified pairing apart from a row nothing graded.

Reference: tenjin-agent#210.
