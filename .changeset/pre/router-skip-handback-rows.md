---
'tenjin-cli': patch
---

A subagent's hand-back, a teammate's message and a message from another session
are no longer read as the user's words in a router packet. They reach the
parent's transcript as `type: "user"` rows (`origin.kind: "peer"`), so a native
call or delegation right after one was routed with the subagent's report as the
current turn, in place of what the user asked. The transcript reader now skips
them by the same frames the prompt hook already skips.
