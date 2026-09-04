---
'tenjin-cli': patch
---

Ask a real child for its finding, and let `publish --finding` publish what the
hook captured. A `SubagentStop` whose payload carries an empty `agent_type` or a
transcript path with no file behind it, and that this session saw no
`SubagentStart` for, now exits before any ask, claim or row; the ask is gated on
the stopping child's own edit markers instead of a session-wide signal; a
`workflow-subagent` is counted under `no-turn` rather than blocked for a turn it
cannot take; a child already harvested records `harvested` without reparsing its
message; and the harvest splits the fence's `# ` title line off before it
flattens the block, so `publish --finding` publishes under the child's own title
with the body unchanged.
