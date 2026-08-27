---
'tenjin-cli': minor
---

Give the child-finding queue a read path, and stop the ask from missing the case it exists for (tenjin-agent#228):

- **`tenjin finding list` and `tenjin finding show <id>`.** A `SubagentStop` harvest stores the child's whole statement, up to 2,000 characters, but the only reader was the capture ask: one paragraph at a turn end, which names the 5 newest findings and clips each body to fit. Both are display bounds, so a parent was told to publish from a preview it could not expand, and a session whose children queued more than 5 findings could not reach the rest at all. The ask now prints each finding's id and points at these two verbs, so the preview stays short and everything stored stays reachable. Read-only and local: no wallet, no shelf, no spend, nothing written.
- **A stored finding is now itself a research signal.** `didResearch` gated the capture ask on a session-owned search row or a qualifying injection, and a capture triggered by a FAILURE leaves neither: the lookup missed, or was weak, local, skipped, or never injected. The ask therefore never fired for exactly the case the child-boundary ask was built to catch, and the child's harvested finding stayed stored with the publish-authorized parent never shown it. A queued finding inside the ask's own window now clears the gate on its own.
