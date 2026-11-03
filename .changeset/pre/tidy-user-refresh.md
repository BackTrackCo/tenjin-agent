---
'tenjin-cli': patch
---

Keep `tenjin update` refreshes at user scope when they run from the home directory, avoiding an unintended project-scoped x402 MCP registration. Recognize symlinked home paths, preserve existing project-only registrations and explicit project installs, and document cleanup for the accidental alpha.18 entry.
