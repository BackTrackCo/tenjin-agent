---
'tenjin-cli': minor
---

Grade a finding against the transcript it actually landed in, including a
subagent's own.

**Every arm now records the subagent it fired inside.** The harness stamps
`agent_id` on a hook input that fires inside a subagent and leaves it off in the
main session, while `session_id` stays the parent's either way — so until now a
row written inside a child pointed only at a parent transcript that holds no
word of what the child did. `injections` gains an `agent_id` column (schema
version 2, migrated in place by the first open of either the CLI or a hook, with
existing rows kept and read as main-session rows), and the prompt, failure,
read/churn, research, dispatch and subagent arms all stamp it. The subagent arm
records the child the finding was relayed TO, which is the file the verdict has
to come out of.

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
