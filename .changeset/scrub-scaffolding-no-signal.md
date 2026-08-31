---
'tenjin-cli': patch
---

The dispatch hook and the WebFetch push arm no longer fire on a question that scrub reduced to bare scaffolding.

`dispatchQuestion` and `fetchQuestion` scrub a subagent prompt or a fetched URL before sending it to the marketplace, and scrub only removes text shaped like a path, a hostname or a secret — ordinary prose survives untouched. When the one topic-bearing run in a prompt or URL was itself path- or entropy-shaped, everything specific was removed and what was left read as a short real question while carrying no signal at all: production lookups traced back to exactly the literal string this suite has used for years as its own query fixture, `a question`, produced this way from real dispatches and fetches rather than stored anywhere as a default (tenjin-agent#197). Both composers now require at least 20 characters of post-scrub content before firing; below that floor the hook no-ops exactly as it already does on a genuinely empty query. A real, substantive prompt or URL is unaffected — the floor only catches what scrub already reduced to scaffolding.
