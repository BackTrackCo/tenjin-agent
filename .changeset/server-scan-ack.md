---
'tenjin-cli': minor
---

Answer the marketplace's server-side publish scan instead of failing on it. The
`tenjin` backend now runs the same rule corpus in its shared write path, so a
publisher not running this CLI is gated too. Until now its refusals reached
`publish` and `edit` as opaque post-consent write failures (exit 4), which is
the wrong shape for a decision the operator can actually act on.

Both writing commands now map the gate's two codes into the consent flow they
already have. A `scan_blocked` is a hard failure, exit 3, with the redacted
findings rendered: the block tier has no acknowledgement path server-side, so
there is none here either. A `scan_needs_ack` merges the server's findings with
this run's local scan, deduped by detector and offset so the same secret renders
once, and refuses as `NEEDS_CONFIRMATION`; an explicit yes re-runs the identical
content carrying the server's ack token, and exactly once, since the token is
bound to that content and that finding set.

Mode semantics are the local ones, unchanged: `review` and `auto` stop on a
server warn the same way they stop on a local one, and `full-auto` acknowledges
it. Callers that must never acknowledge, whatever the configured mode says, pass
`ackServerWarnings: false`.

Findings travel as data — detector id, tier, redacted excerpt, offset — so a
detector this release has never heard of renders faithfully rather than being
dropped, and the server stays authoritative under version skew. Findings the
gate contributed are marked as such in the rendered lines, because "fix your
file" and "the marketplace refused this" are different instructions.

While the backend's warn tier is still advisory it rejects nothing and reports
its findings on the success response instead. Those now reach the receipt as a
`scan` field and the human summary as informational lines. They never block, and
the `checks.semantic` marker rides along with them.
