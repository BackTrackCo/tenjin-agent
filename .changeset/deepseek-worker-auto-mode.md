---
'tenjin-cli': patch
---

A DeepSeek worker in Claude Code keeps the permission mode the parent had when its offer was accepted for the whole job, so typing or switching mode in the parent no longer stops it. In auto mode a worker never waits on you: its native classifier judges each call, and a call that would still need a person is denied with its reason. In default mode its permission dialog shows the command and the reason, with Allow once, Allow for this job or Deny. Bypass-permissions parents now get offers too, unless settings disable bypass mode; plan mode stays native. In every mode a worker never runs keychain or git credential probes, `gh auth token`, a push to `main` or `master` or without a named branch, a force push, a branch deletion, a merge or a repository delete. A worker that stops early hands its last text and recent activity back to the parent. Charges, quotes and settlement are unchanged.
