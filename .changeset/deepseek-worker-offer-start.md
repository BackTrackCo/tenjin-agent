---
'tenjin-cli': patch
---

Start preparing Claude Code locally while a DeepSeek offer is open. The worker receives its assignment only after the parent accepts. A veto, cancellation, expiry, or parent-session end stops the waiting process. On macOS and Windows a worker prepared this way no longer waits for its env file scan before its Claude Code starts when the session already scanned the same directories: it starts from that scan, and gets no assignment until its own full scan has ended and agreed.
