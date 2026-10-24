---
'tenjin-cli': patch
---

Tenjin now updates itself in Codex too. Codex stops Tenjin's server with a signal that ended it before the daily background update could start, so a machine that runs Tenjin only in Codex stayed on the version it was installed with; the update now starts as that signal arrives, and on Windows, where Codex gives no signal, as the session starts.
