---
'tenjin-cli': patch
---

A subagent's native-call packet keeps the subagent's own task once its transcript passes 4 MB, read from the head of the file, instead of carrying the parent's latest message.
