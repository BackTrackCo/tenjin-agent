---
'tenjin-cli': patch
---

A DeepSeek worker's model request that follows a tool result now runs one check of the workspace's env files, where it ran two in a row. The check still waits its full time for file changes after the request arrives, and reads only after that wait. On macOS and Windows this removes one 120 ms wait and one listing before each such request.
