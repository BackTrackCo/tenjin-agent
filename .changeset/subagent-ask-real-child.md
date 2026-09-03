---
'tenjin-cli': patch
---

Ask a real child for its finding, and let `publish --finding` publish what the
hook captured. A `SubagentStop` with no `SubagentStart` row, an empty
`agent_type` or a transcript path with no file behind it now exits before any
ask, claim or row; the ask is gated on the stopping child's own edit markers
instead of a session-wide signal; a `workflow-subagent` is counted under
`no-turn` rather than blocked for a turn it cannot take; a child already
harvested records `harvested` without reparsing its message; and the capture ask
asks for a `# ` title inside the fence, which `publish --finding` uses as the
title, falling back to the finding's first sentence.
