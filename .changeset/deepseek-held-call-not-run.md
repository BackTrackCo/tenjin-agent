---
'tenjin-cli': patch
---

Show a held Agent call as not run in Claude Code. Tenjin answered a held call as a completed result that carried the DeepSeek offer, so Claude Code's own summary of several Agent calls read `agents finished` and `Done` for calls that had only been held. A held call is now answered as a refusal whose text carries the same offer, and says first that Tenjin offered DeepSeek and that the call has not run. The parent still accepts the offer or sends the call again unchanged to keep it native.
