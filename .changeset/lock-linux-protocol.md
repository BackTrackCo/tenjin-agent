---
'tenjin-cli': patch
---

On Linux, subagents use an exclusive SQLite lock with an in-memory journal. Once the lock file exists, the process can take the lock in a read-only folder. It holds the lock until it releases it or exits.
