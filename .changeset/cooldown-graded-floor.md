---
'tenjin-cli': patch
---

The adaptive cooldown's cold floor counts graded lookups, not all lookups.

The cold rule cut a push arm's cap to a third when it had `20` hits or more and
a use rate under `5%` — but the two numbers came from different populations.
`hits` is every lookup that returned a candidate, while `rate` is
`used / (used + wrong)` over only the lookups something graded. So the floor,
whose whole job is "wait until enough outcomes back the rate", was clearing on
lookups nobody had judged: an arm with 40 hits and five grades, none of them
`used`, cleared a floor that reads as "we have seen enough of this arm" and lost
its cap `8` → `2` on the strength of five outcomes.

The floor is now on graded lookups (`used + wrong >= 20`), the same count the
rate is drawn from. The hot rule (`rate >= 0.4` doubles the cap) has no floor
and is unchanged, as is the guard that leaves an ungraded trigger at its base
cap; with the floor counting grades, that guard is now the floor's first step
rather than a separate rule. `hits` stays in the stored `trigger_rates` row as
telemetry and no longer feeds any decision.
