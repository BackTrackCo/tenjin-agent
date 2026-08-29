---
'tenjin-cli': patch
---

Push hooks in team mode now ask the team shelf and the public shelf at the same time instead of one after the other. A slow team leg used to spend the shared search budget and leave the public leg with no time (`no-time`), or on fixed timeouts overrun the prompt arm's own budget with a hit computed and never emitted. Joined, the lookup's wall clock is the slower leg plus a body fetch, which is the sum every watchdog was already sized for; the request count doubles on team-mode fires, and so does what a fire spends of its trigger's hourly lookup allowance: both legs' rows count, so 60 lookups is 30 team-mode fires. The cap and quiet gates now run once per fire, sized to the legs it will spend, rather than once per leg — a per-leg check read the same count twice and passed both legs at one lookup left, and bumped the cold arm's escape counter twice per fire so every other escape pass landed on a leg whose answer was then discarded. `tenjin search` and the dispatch hook keep their sequential legs.

The verdict reads the top three candidates rather than rank 1 alone: the first one the shelf corroborated and did not call `low` is the hit, and when none qualifies rank 1 is recorded on the `weak` row as before. Push arms ask the shelf for three candidates (`limit: 3`); the WebSearch hint still asks for two.

A new ledger reason, `shadowed`, marks a strong public answer on a fire the team shelf also answered strongly: the team answer is delivered, the public one is recorded, and `tenjin push status` counts it with the other reasons.
