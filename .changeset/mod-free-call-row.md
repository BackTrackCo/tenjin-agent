---
'tenjin-cli': patch
---

The Claude Code transcript now shows a free lookup the agent ran by its line's id, such as Context7 docs, as `Called Context7 docs · free`, also when the agent calls it after the name the CLI kept for it has expired (15 minutes). The router's own free calls (a spec, a browse, a tool's spec) and answers that ask for input still show nothing.
