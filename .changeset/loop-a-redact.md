---
'tenjin-cli': minor
---

One redact module. `src/lib/redact.ts` replaces `scan.ts`: `findings(text, scope)` is the
publish scan with the audience as a parameter (`publish` reports every rule, `team` reports
the rows scoped to it, so publish, edit and sync pass a scope and filter nothing), and
`redact(text)` is the destructive scrub for hook queries, with bound, strip order and squash
owned by the module. One rule table, `redact-rules.json`, carries `scopes` instead of
`teamSurvives` plus five `query`-scoped strip rows lifted from the hook scrub; one fixture set,
`redact.fixtures.json`, replaces `scan-corpus.json`. `secret-assignment` now also fires on
`--api-key <v>` flags and `X-Api-Key:` headers, so a hex-only key in a recorded command line
is reported on a team shelf (tenjin-agent#281) while a bare commit SHA still syncs. The hook
templates are unchanged; they switch to `redact()` when the arms move onto the daemon kernel.
