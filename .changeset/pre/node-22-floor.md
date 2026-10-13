---
'tenjin-cli': patch
---

The CLI now runs on Node 22, the same floor Claude Code needs (was Node 24). Human output stays plain when piped on every Node 22 release. Routing through HTTPS_PROXY still needs Node 24.14 or newer, and `tenjin doctor` says so.
