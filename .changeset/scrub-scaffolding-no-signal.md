---
'tenjin-cli': patch
---

The dispatch hook and the WebFetch push arm stop scrubbing paths, hostnames and other identifiers out of a search query: search availability wins over sanitizing away the best search key the server has.

Both `dispatchQuestion` and `fetchQuestion` used to build a search query by scrubbing a subagent prompt or a fetched URL of anything shaped like a path, a hostname or a secret, on the theory that only prose should leave the machine. That traded away the one thing most likely to make a lookup land: the server now does identifier-aware BM25 retrieval, and a path or a hostname is exactly what it matches on. It also produced its own failure mode (tenjin-agent#197): when the one topic-bearing run in a prompt or URL was itself path- or entropy-shaped, scrubbing it away left bare connective prose ("a question", "for a question about it") that read as a short real question while carrying no signal — production lookups traced back to exactly that literal, used for years as this suite's own query fixture.

The two arms now split on what each one is actually protecting against. `fetchQuestion` (the WebFetch push arm) drops scrubbing entirely: the URL has already left the machine via the fetch itself, so scrubbing our own search copy of it protects nothing, and removing the call also removes the one place a dotted, slash-free pathname could make the host-matching rule run quadratically in front of a tool call. `dispatchQuestion` (the Task/Agent dispatch arm) keeps scrubbing, but now only SECRET-shaped tokens — a Task prompt can embed an API key that is not otherwise outbound, and a team-shelf miss forwards this same query to the public marketplace, so a credential still cannot ride along. Paths, hostnames and other identifiers in a dispatch prompt now ship too. `scrub()` itself gained a `mode: 'secretsOnly'` argument for this; every other caller is unaffected and keeps the full path/host/email/hex-id behavior.

The floor this arm used to apply below 20 characters of post-scrub content is gone along with the residue it was gating on: with paths and hostnames no longer stripped, a short question built around one no longer collapses to scaffolding, so there's nothing left to floor. What remains is the trivial case — an empty or whitespace-only result — and the existing guard against composing a description-only query with a dangling colon when a prompt scrubs to nothing.

Existing installs keep whatever hook script `tenjin install` last wrote; this change only reaches a machine that reinstalls or upgrades the hooks (`tenjin install`).
