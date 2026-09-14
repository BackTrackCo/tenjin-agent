---
'tenjin-cli': patch
---

Send the whole prompt to the shelf, not its first 512 characters. `queryMax`
now returns the long-query bound (8,000) for `prompt` as well as `dispatch`, so
the prompt arm's cut in `question()` moves with it and the shelf splits the text
into sentence sub-queries and reranks against the whole of it.

An engineering ticket typed as a prompt runs 2,000 to 5,000 characters and opens
with rules, so the old 512-character head was the preamble and not the question:
the team leg missed even when the word leg ranked the right piece first. The
trigger stays `prompt` on the wire, so the per-arm shelf policy and the
telemetry are unchanged. Needs the matching server change
in BackTrackCo/tenjin; against an older shelf a long prompt is a `400` on the
prompt leg, which the arm reports and the turn continues without an injection.
