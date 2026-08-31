---
'tenjin-cli': patch
---

The dispatch hook and the WebFetch push arm no longer fire on a question that scrub reduced to bare scaffolding.

`dispatchQuestion` and `fetchQuestion` scrub a subagent prompt or a fetched URL before sending it to the marketplace, and scrub only removes text shaped like a path, a hostname or a secret — ordinary prose survives untouched. When the one topic-bearing run in a prompt or URL was itself path- or entropy-shaped, everything specific was removed and what was left read as a short real question while carrying no signal at all: production lookups traced back to exactly the literal string this suite has used for years as its own query fixture, `a question`, produced this way from real dispatches and fetches rather than stored anywhere as a default (tenjin-agent#197).

Both composers now require at least 20 characters of post-scrub content, but only once scrub has actually removed something — never on raw length. A first cut of this fix applied the floor unconditionally, which dropped short _real_ questions the `fetchQuestion` arm sees with no length precondition of its own (a WebFetch prompt of "is it free?"), and could compose a description-only query with a dangling colon (`description + ': ' + head` when `head` gated to empty) — the exact scaffolding class this fix targets, from the other side of the join. Both are fixed: the floor now compares scrub's output against the pre-scrub text (whitespace-normalized, so an incidental space collapse never counts as "removed") and fires only on real residue, and a dispatch whose head gates to empty sends no query at all, regardless of the description.
