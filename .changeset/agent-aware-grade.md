---
'tenjin-cli': minor
---

Grade a finding against the transcript it actually landed in, including a
subagent's own.

**Every arm now records the subagent it fired inside.** The harness stamps
`agent_id` on a hook input that fires inside a subagent and leaves it off in the
main session, while `session_id` stays the parent's either way — so until now a
row written inside a child pointed only at a parent transcript that holds no
word of what the child did. `events`, `injections`, `searches` and
`pairing_closes` all gain an `agent_id` column in one step, and the prompt,
failure, pass, edit, research, dispatch and subagent arms all stamp it. The
subagent arm records the child the finding was relayed TO, which is the file the
verdict has to come out of; the close on a pairing records the worker that made
it, and counts for nothing — the promotion to `verified` still asks for two
independent SESSIONS, because two subagents of one conversation are one laptop
in one checkout.

**Schema version 2, and tenjin-agent#247 is what it is.** Anything after this
takes version 3. A fresh file is CREATED at the current shape and steps nothing;
a file that already exists is altered in place by the first open of either the
CLI or a hook, keeping every row. The step also BACKFILLS `events.agent_id` from
the `data.agentId` that tenjin-agent#242 has been writing since 2026-08-28, so
the fortnight of rows in between are still the worker's rather than the lead's.
`ALTER TABLE ADD COLUMN` is not idempotent, so the version is re-read inside the
`BEGIN IMMEDIATE` and the create and migrate branches are exclusive — pinned by
a dozen hook processes racing one version 1 file, and by a version 1 hook core
writing to a version 2 file, which is the ordinary state of a machine that
upgraded the CLI without re-running `tenjin install`.

**One identity, parsed once.** The prelude has a single reader, `identityOf`,
answering the session and the agent together; an id that is not `[A-Za-z0-9_-]`
of 1–128 characters is refused rather than stripped, because it is also a
transcript filename and stripping a separator out of one id spells another id
exactly. `NULL` is the main session everywhere and never "unknown", with the one
place it becomes the `''` a `session_state` key segment needs spelled out as
`agentKey` — so `edited::<path>`, `edits::<path>` and `replayed::<head>` are
byte-for-byte the keys the lead's rows already sit under. The importance score
reads the `events` column instead of a JSON field, which is what makes "this
child was shown a finding" and "this child then fixed something" the same worker
rather than two.

**An id the harness stamps but this build cannot use is not the lead.** It fails
the bound, so it names no transcript and no partition; filing the fire under the
main session instead would hand a child's search, edit or close to its parent,
and the score would then read that work as the lead's. Every arm drops such a
fire whole — no lookup, no event row, no decision row — rather than inventing a
reason bucket for a row that should not exist.

**`tenjin push grade` reads that file.** A row with an agent id is judged against
`<session>/subagents/agent-<id>.jsonl`, never the parent's. A relayed finding has
no anchor row in any transcript — the child is handed it as its opening context
and nothing records it — so it is judged from the child's first tool call onward,
by the same evidence rules everything else gets. It also leaves no injected text
on disk, so its span evidence comes from the piece's title alone, which usually
means a relayed finding is judged on the strong evidence (an explicit read, or
the URL) or not at all.

**`unobserved` narrows to what it always meant:** nothing to read and nothing
that ever will be. Every subagent injection used to land there unconditionally,
which closed the whole handoff as never-seen; now only a relayed row with no
agent id recorded does — rows written before this version, or by an arm that
could read none off its input. `--explain` names the agent and the file that
answered.
