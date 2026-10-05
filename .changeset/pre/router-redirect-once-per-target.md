---
'tenjin-cli': patch
---

The pre-call router hook now keeps its promise that a redirected WebSearch or
WebFetch is not redirected again. It kept one "last redirect" per agent and let
any next offer in the same category spend it, so with parallel calls one call's
redirect was used up by another and the agent's own retry was denied again: the
same URL could be denied three times in a row. Each redirect now claims its exact
search, or its URL as parsed, for that agent, one file per claim so parallel hook
processes never share a record. A retry of the same search or URL runs as it is
for ten minutes, whether the redirected lookup succeeded, failed or was never
called, and two parallel copies of one call are denied once. Every other search
or URL still gets its own first redirect, and the main agent and each subagent
keep their own claims.
