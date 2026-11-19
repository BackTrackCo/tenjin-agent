---
'tenjin-cli': patch
---

A DeepSeek worker's model call no longer waits for another session's call while an inference channel is idle. On a router with shared channels, a call takes its worker's own lane when it is free and the other lane when another call holds its own; it waits only when both are held. On a router that refunds, each run's calls wait on that run's own channel alone. Each channel still carries one paid call at a time, so no voucher total is signed twice. The diagnostic record says which lane a call paid on (`slot`, `laneMoved`) and whether it waited on this process or another (`waitedOn`).
