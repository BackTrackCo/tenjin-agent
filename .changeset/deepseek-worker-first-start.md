---
'tenjin-cli': patch
---

The first DeepSeek worker of a session now reads its subagent prompt while its env file scan runs. It used to wait for the scan, then for the read. The worker's Claude Code still starts only after the scan has ended.
