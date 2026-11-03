---
'tenjin-cli': patch
---

A live status line names each lookup while it runs: `routing`, then the provider
endpoint actually called with its bounded, redacted parameters, then the outcome
and the price. `tenjin install` registers `tenjin status-line` as Claude Code's
status line when that key is free; a status line you already set is never
replaced, and `--status-line compose` appends ours to it.
