---
'tenjin-cli': patch
---

`push status --sessions` no longer credits a sibling subagent's pairing close or
search.

The report already scored one line per (session, agent) — parallel subagents
share their parent's session id, so scoring a session whole stitched one
worker's failure to another's edit and called it a fix. Two of its inputs were
still read per session, though: `pairing_closes` and `searches`. So a child's
close still completed a sibling's `error-edit-resolved`, and a child's search
still completed a sibling's `research-then-edit` — the same defect, one table
over.

Both tables have carried `agent_id` since store `user_version` 2, and the
report now reads it: closes and searches are keyed by the same (session, agent)
pair the events are, and each worker is scored against its own rows only. The
score is a report and nothing gates on it, so this changes numbers, not
behaviour.

The two-independent-closes promotion behind `pairings` is deliberately
unchanged and still counted per session: two subagents of one conversation are
one laptop running one checkout, and letting them count as two closers would
hand out a `verified` nobody independently observed.
