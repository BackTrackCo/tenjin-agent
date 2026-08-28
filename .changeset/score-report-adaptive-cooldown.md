---
'tenjin-cli': minor
---

`tenjin push status --sessions` scores each session's importance as a report, and the push arms' lookup caps adapt to the shelf's per-trigger use rates, guarded so nothing changes until a lookup has been graded (tenjin-agent#212, PR B).

**`tenjin push status --sessions`** appends one line per session in the 7-day window: an importance score over the session's event rows and pairing closes (five patterns, each once per session — error→edit→resolved 3.0, the same file edited across a prompt 2.5, a Write over a much-edited file 2.5, fail→non-test edit→same head passes 2.0, research then edit 2.0 — with up to +30% when the last resolution or reversal was within 300 s of the session's end), printed beside whether the capture ask fired and how many publishes happened while the session was open. Nothing reads it: the Stop hook's capture gate is unchanged, and the report is what says where a gate on the score would sit.

**The lookup cap adapts.** The SessionStart primer fetches `GET /api/lookups/stats?days=7` from the configured shelf once per session, while push is on, into the session's `trigger_rates`; each arm's hourly cap then scales from its own trigger's rate (`used / (used + wrong)`): ×2 at a rate of 0.4 or more, ÷3 at twenty-plus hits under 0.05 with every 10th suppressed fire passing anyway. A trigger with no graded outcome keeps its base cap however many hits it has, so the cooldown ships inert and turns itself on per trigger the day the first outcome is graded against it (tenjin-agent#210). A failed fetch leaves every cap as it was.
