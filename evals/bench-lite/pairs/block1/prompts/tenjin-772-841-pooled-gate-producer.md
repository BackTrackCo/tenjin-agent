# The decision search can no longer say no

The decision view's verdict has only ever meant "retrieval returned zero rows". No relevance
rule was ever written; what acted as one was retrieval being narrow, and three recent
changes removed that narrowness, so one incidental word inside a long paid piece is now
enough to retrieve it. Every client that keys on a miss therefore never falls through: a
probe of ten team-mode lookups asked the public shelf zero times, and a prompt asking for a
haiku about ducks came back with three candidates.

Give the decision view a relevance floor. A candidate survives only if it is semantically
close enough on its own, or if the keyword leg independently matched it beside a close
semantic hit. A candidate that is neither is refused, and when nothing better exists the
shortlist is empty and the verdict is a miss. Refuse inside retrieval at the existing
per-row seam, before the top-K cut, so a refused row never occupies a slot a qualifying row
would have taken. This applies to the fused path only; a response with no semantic leg
passes through unfloored and says so in its calibration. The display view and the plain
article listing are untouched, and the buckets and floors already in the code are not
being retuned.

The hard part is what "the keyword leg independently matched it" may key on. It must not
key on membership in the semantic leg's result window: a piece ranked just outside that
window, or crowded out by many near neighbours from one author, would be refused rather
than ranked low, and a freshly published piece with no vectors would be invisible until it
was embedded. Score each candidate on its own evidence instead, from an exact scan over
that row's own vectors, issued concurrently with the semantic leg so it costs no extra
round trip. Window membership stays as a separate fact, because telemetry uses it to
measure how much the semantic leg contributed, and it must not become a gate. Exempt a
piece whose vectors have not landed yet, bounded to about a day since its last edit, so the
publish-then-search-a-minute-later loop still works while an empty body reconciled to zero
chunks is not exempt forever. Update the machine-facing docs and tool descriptions that the
floor falsifies. Run only the focused test files you touch; the integration lane needs Docker.
