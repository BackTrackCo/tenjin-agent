---
'tenjin-cli': patch
---

Make the Linux file lock of the DeepSeek worker safer: a take creates no side file, so it works in a read-only folder, and a lock no longer drops if the caller loses its release.
