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

A confirmation covers the findings it post-dates, so a `--yes` clears the
server's hold only when the merge added nothing the local pass had not already
rendered. The `--yes` was an answer to a payload built before any server call,
and the marketplace's set is strictly larger than the local one (its semantic
checks have no local counterpart at all), so reading that yes as an answer to
findings it could not have contained is reading it as an answer to a question
nobody asked. `review` and `auto` therefore stop on a server-only warn even with
`--yes`, render it marked `[server]` with its tier, and say in the fix that the
yes did not cover it. `full-auto` still acknowledges unasked: clearing soft
findings unasked is that mode's contract.

New config key `publish.ackServerWarnings` sets a standing answer without
changing the mode. `off` never acknowledges, which is the off switch an
unattended `full-auto` machine needs; `on` lets a `--yes` cover the server's
findings too, which is what a non-interactive machine sets once instead of
re-running forever; `mode` (the default) derives the answer as above. It reads
from the global config only, never from a project `.tenjin.json`, because it can
only ever loosen what a yes covers. In-process callers whose answer is not the
operator's to configure still pass `ackServerWarnings: false` and never
acknowledge at all.

Findings travel as data — detector id, tier, redacted excerpt, offset — so a
detector this release has never heard of renders faithfully rather than being
dropped, and the server stays authoritative under version skew. Findings the
gate contributed are marked as such in the rendered lines, because "fix your
file" and "the marketplace refused this" are different instructions.

While the backend's warn tier is still advisory it rejects nothing and reports
its findings on the success response instead. Those now reach the receipt as a
`scan` field and the human summary as informational lines. They never block, and
the `checks.semantic` marker rides along with them.
