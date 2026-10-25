---
'tenjin-cli': patch
---

Tenjin now updates itself in Codex too. Codex stopped Tenjin's server before the daily background update could start, so a machine that runs Tenjin only in Codex stayed on the version it was installed with; the update now starts as a Codex session starts. Such a machine needs one `tenjin update` by hand to get this release, and updates itself from then on. In Claude Code, the daily update now starts even when Tenjin's session-start step fails, so the next release can still replace a build that fails there.
