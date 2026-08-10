---
'tenjin-cli': minor
---

Make the MISS → publish loop closable on the path agents actually take. Until now
only `tenjin publish --candidate <id>` could name the search it answered, so the
bare file publish that both the Stop hook and the auto-mode skill prescribe left
the search open in the local store and the reminder kept firing at work that was
already on the marketplace. `tenjin publish <file.md> --search-id <id>` now closes
it, and prefills the searched question into the answer card's `questionsAnswered`
when neither `--question` nor the draft's frontmatter names one — that phrasing is
what the next searcher sends, so it is the right fallback. The prefill is dropped
rather than truncated when the stored question runs past the card's 200-character
item bound, because a prefill nobody asked for must not fail a publish that was
otherwise fine. `--search-id` with `--candidate` is a usage error (the candidate
already carries its own searchId), a malformed id refuses before any wallet touch,
and an id the local store does not know still publishes and says so. What happened
is reported in both registers: a stderr line for a human, and a
`search: { id, closed }` field on the JSON receipt, because `--json` suppresses
the stderr notes and an agent that named a search could otherwise not tell a
closed loop from an open one.

A `--draft` now parks privately on BOTH paths and closes nothing. It leaves the
named search open, and — this is a behavior change — it also leaves a
`--candidate` draft parked instead of clearing it. A draft answered nobody, so it
is not the publish that retires the pen entry; the later real publish is. The
receipt reports `cleared: false` with no `warning`, which is how a deliberate hold
reads against a clear that failed.

Every surface that hands you the closing command now hands you a complete one. A
MISS's `publishBack` payload emitted `tenjin publish <file.md> --json` beside a
`park` line that already carried the id, so the arm the agent was most likely to
copy was the one that closed nothing; both arms, and the stderr line beside them,
now name the searchId.

The Stop hook's open-loop reminder is reworded to match. It named a flag that did
not exist (`tenjin publish, searchId <id>`) and it carried no safety qualifier, so
it nagged just as hard on a question about private infrastructure as on a durable
public finding. It now emits the real command and conditions the publish arm on
the finding being public, reusable and rights-clean, with parking as the other
arm. The batched line for WebSearch-hook misses gets the same command syntax.

**The reminder is now scoped to the session that opened the loop.** The search
ledger is machine-global, so the Stop hook was raising whichever open MISSes it
found at whatever session happened to stop next, including a sibling session's
work that this one never did and cannot close. A stored search now carries an
optional `sessionId`, and the Stop hook parses the `session_id` its turn-end
payload already carries and skips entries stamped with a different one — without
marking them nagged, so the session that owns a loop still gets its single
reminder. The scoping is deliberately one-directional: an entry nothing could
attribute is still raised in every session, so a loop can never go invisible in
all of them at once, and a payload that is malformed or names no session falls
back to exactly the old machine-global behavior.

Only the WebSearch hook can stamp reliably, because the harness hands a session
id to hook scripts on stdin and exports none to Bash subprocesses, which is what
a deliberate `tenjin search` runs as. That path stamps only when the operator
exports `TENJIN_SESSION_ID`, and records nothing rather than guessing otherwise.

The `tenjin-publish` skill's draft rules now say where the free/paid fold falls: a
piece whose Answer section sat too high leaked its verdict into the public
excerpt, so the rule names the first ~500 characters as the excerpt and puts the
as-of date, versions and questions answered above the verdict.
