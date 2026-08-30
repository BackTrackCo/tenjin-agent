---
'tenjin-cli': patch
---

Push hooks in team mode now ask the team shelf and the public shelf at the same time instead of one after the other. A slow team leg used to spend the shared search budget and leave the public leg with no time (`no-time`), or on fixed timeouts overrun the prompt arm's own budget with a hit computed and never emitted. Joined, the lookup's wall clock is the slower leg plus a body fetch, which is the sum every watchdog was already sized for; the request count doubles on team-mode fires, and so does what a fire spends of its trigger's hourly lookup allowance: both legs' rows count, so 60 lookups is 30 team-mode fires. The cap and quiet gates now run once per fire, sized to the legs it will spend, rather than once per leg — a per-leg check read the same count twice and passed both legs at one lookup left, and bumped the cold arm's escape counter twice per fire so every other escape pass landed on a leg whose answer was then discarded. `tenjin search` and the dispatch hook keep their sequential legs.

The verdict reads the top three candidates rather than rank 1 alone: the first one the shelf corroborated and did not call `low` is the hit, and when none qualifies rank 1 is recorded on the `weak` row as before. Push arms ask the shelf for three candidates (`limit: 3`); the WebSearch hint still asks for two.

A new ledger reason, `shadowed`, marks a strong public answer on a fire the team shelf also answered strongly: the team answer is delivered, the public one is recorded, and `tenjin push status` counts it with the other reasons.

The hourly lookup allowance is now counted **per session** rather than per machine. Machine-wide, ten concurrent sessions shared one hourly allowance and burned it in the first half hour, so every session that started later was capped before it had asked anything and the sidecar went quiet exactly when the laptop was busiest. Each session now gets its own 60 lookups per rolling hour per trigger, and there is deliberately no machine ceiling over the top: a stuck loop is one session, and it is still bounded by that same 60 an hour per arm.

A team hit the session has already been shown no longer swallows the public answer. `shelfDeliver` returns nothing for a piece already injected or relayed this session, and shadowing the public hit behind it spent the fire on two strong answers and emitted neither; the public answer now stands on its own, exactly as it does under a team miss.

One leg of a team-mode fire can no longer take the other down. Both legs run under one `Promise.all`, so anything that threw while reading a shelf's response rejected the pair and the fire emitted nothing and wrote no row for either shelf; a leg that throws is now recorded as the `no-answer` it is, and the other shelf's answer is delivered.
