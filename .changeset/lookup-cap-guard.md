---
'tenjin-cli': patch
---

The hook lookup cap is a runaway guard now, not a budget: 60 an hour per trigger, machine-wide.

At `8` an hour per trigger, counted across every session on the machine, four or five concurrent sessions left each one about two prompt lookups an hour — 65 `lookup-cap` skips in a week on one machine, eleven in a row inside the one confusion a teammate's note would have answered (tenjin-agent#255, #258). A lookup is one short search and one embedding call, so the cap was rationing something that costs nothing to spend, and while the team experiment is being measured every skipped lookup is a data point lost. Every bucket (`prompt`, `failure`, `research`, `subagent`, `read`, `churn`, and the default for an unnamed arm) is `60` now — 360 lookups an hour machine-wide, 720 with the hot rule doubling every arm, the only client-side bound on shelf egress; the rolling window, the per-trigger buckets, the machine-wide count and the adaptive cooldown are unchanged, so a stuck loop is still stopped and a graded arm still scales on evidence.
