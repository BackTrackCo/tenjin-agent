---
'tenjin-cli': minor
---

state.db `user_version` 2: `searches` and `pairing_closes` record the agent, so
`push status --sessions` no longer credits a sibling subagent's close or search
to another worker. Parallel subagents all file under their parent's `session_id`,
so a close or a search stamped with the session alone belonged to every worker in
it at once, and the importance-score report completed one agent's
`error-edit-resolved` with a sibling's close and its `research-then-edit` with a
sibling's search. Both tables now carry an `agent` column and the report
partitions them on `(session, agent)`, the same key the event rows already used.

An existing database is migrated in place on the next open, inside the same
`BEGIN IMMEDIATE` the bootstrap always used; rows written before the column
existed, and closes or searches nothing could attribute, count as the lead's own
turn. Pairing promotion is unchanged and still counts sessions: two subagents of
one conversation are one machine in one checkout, not the two independent closes
that reach `verified`.
