---
'tenjin-cli': patch
---

Fixed two grader defects: a backtick span that is standing boilerplate before
the injection anchor (e.g. `CI=true pnpm format:check` named in a subagent's
own work order) no longer reads as "copied from the note" whether or not an
injection happened, and a command named in prose with no backticks now scores
against a new `used-likely` tier instead of always coming back `rejected`,
however precisely the agent followed it.

`used-likely` extracts command heads and file basenames from the note's full
body and credits a match within the grading window, ranked below `read` and
`span`. Verdict's `by` field gains `'likely'` alongside `'read' | 'span'`;
`push status`'s `wireStatus()` reports it as `partially_used`, same as `span`,
since both are weaker-than-a-followed-pointer evidence.

Review follow-ups on the same fix: the pre-injection exclusion window is now
bounded to the same `SPAN_WINDOW` on both sides instead of the whole session,
and matches at a token boundary so a longer pre-injection token (e.g.
`db:generate-types`) can no longer erase credit for a shorter genuine one
(`db:generate`); the injection template's own opener and closing line are
excluded from `used-likely` candidates so the grader never credits its own
boilerplate; and `push grade`'s default line now breaks `used=` down by tier
(`read`/`span`/`likely`) instead of only under `--explain`.
