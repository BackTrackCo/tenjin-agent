---
'tenjin-cli': minor
---

Search v2: this CLI now requires a server at `schemaVersion` 2
(BackTrackCo/tenjin#501). A pre-v2 deployment refuses the request at its own
schema gate, and the CLI reports that as `CONTRACT_MISMATCH` naming the server
rather than a generic contract drift, so the break fails loudly instead of
degrading.

Candidates are lean. A hit now carries `resourceId`, `url`, `slug`, `title`,
`artifactType`, `price`, `asOf`, `validUntil`, `matchReasons`,
`estimatedTokens`, and `creator.handle`: enough to shortlist and to price the
decision, and nothing more. `questionsAnswered`, `tasksSupported`, `appliesTo`,
`scope`, `exclusions`, and `temporalMode` are gone from the candidate, and the
requested `--limit` is honored for a within-bounds page. A new optional
`truncated: true` marks a response whose trailing candidates were dropped for
size.

The answer card moves to `tenjin inspect` (BackTrackCo/tenjin#500), which is
free and never pays: the unpaid 402 body now carries the piece's card, so what
it answers, what it applies to, what it excludes, its freshness dates and its
provenance are read there before any purchase. Search is the breadth step and
inspect is the depth step, so inspect is no longer optional before a buy.
