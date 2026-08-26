---
'tenjin-cli': patch
---

Hook noise fixes (tenjin-agent#211):

- The push failure arm fires only behind build/test/migrate/install/lint command heads (never `which`, `grep`, `test`, `diff`, `ls`, or `git diff --exit-code`, which exit 1 to mean "no"), and only on a real error marker in the output tail (`FAIL`, `AssertionError`, `N failed`, `Error:`-class lines, tracebacks, `exit code N`, errno codes, toolchain prefixes) rather than prose words like "error", "failed" or "not found". Stderr chatter with no marker is success. `which codex` no longer injects an unrelated note.
- A lookup bucket that is full is recorded once per window; the session remembers when it refills, and later capped fires on that arm exit without a ledger row or a 256 KB ledger-tail parse. Interim until the state store in #209.

- The subagent-dispatch hook now names a piece only on a **strong** hit. A subagent prompt is a work order rather than a question, so keyword overlap with a marketplace listing means much less there: three Agent calls produced six pointer lines and none of them applied. A moderate or absent match is recorded to the push ledger (`trigger: dispatch`, `action: logged`) and never shown, and a strong hit names rank 1 alone rather than every candidate the shelf returned. The ledger row is written whether or not `hooks.push` is on, since the noise it replaces was identical either way.
- The Stop-hook capture ask now **waits for background subagents**. Claude Code fires `Stop` when the parent's turn pauses, which is not the end of a turn that still has subagents running — the ask arrived before the session had learned what it was being asked to write down, and, because the marker is written at first ask, it never came back at the real end. Running launches are read from the tail of the session transcript; a transcript that cannot be read fails toward asking, exactly as before.
- In team mode the dispatch hook now falls through to the public marketplace when the team shelf's best candidate is short of `strong` (before, any team candidate at all — and a search has no floor — shadowed the public shelf entirely; probed: ten team-mode dispatches, public asked zero times). The public answer replaces the team one only when it is stronger.
