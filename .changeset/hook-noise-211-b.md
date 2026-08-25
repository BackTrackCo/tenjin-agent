---
'tenjin-cli': patch
---

Hook noise fixes (tenjin-agent#211):

- The subagent-dispatch hook now names a piece only on a **strong** hit. A subagent prompt is a work order rather than a question, so keyword overlap with a marketplace listing means much less there: three Agent calls produced six pointer lines and none of them applied. A moderate or absent match is recorded to the push ledger (`trigger: dispatch`, `action: logged`) and never shown, and a strong hit names rank 1 alone rather than every candidate the shelf returned. The ledger row is written whether or not `hooks.push` is on, since the noise it replaces was identical either way.
- The Stop-hook capture ask now **waits for background subagents**. Claude Code fires `Stop` when the parent's turn pauses, which is not the end of a turn that still has subagents running — the ask arrived before the session had learned what it was being asked to write down, and, because the marker is written at first ask, it never came back at the real end. Running launches are read from the tail of the session transcript; a transcript that cannot be read fails toward asking, exactly as before.
