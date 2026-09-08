---
'tenjin-cli': minor
---

The CLI reads and writes `loop.db` (PR E).

`state.db` is gone: the search record, the publish-dedup facts and the loop's own reports all live on the loop database the daemon already owns, and `tenjin doctor --prune` deletes the retired store and the five files it replaced rather than importing them. `tenjin sync` is deleted — the failure arm keys a failure exactly, once, and a fix this session closed is named in the turn-end ask with the key it was recorded under, for the agent to publish itself with `publish --key fingerprint=<key>`, which stamps the pairing. `outcome --last` and the per-session importance report are deleted: the CLI knows the harness session but never the agent inside it, so in a fan-out either one could rate a sibling's work.
