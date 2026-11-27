---
'tenjin-cli': patch
---

Setup no longer asks "Use a cheap model for eligible subagent jobs?". `tenjin install --subagents` and `tenjin config subagents` are gone, and `tenjin status` has no Subagents row. Tenjin holds no Agent call and offers no DeepSeek job. A subagent setting an earlier version saved stays in your config file: it is ignored, costs nothing and causes no error.
