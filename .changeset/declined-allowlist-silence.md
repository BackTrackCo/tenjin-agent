---
'tenjin-cli': patch
---

`tenjin install --refresh` no longer re-reports a declined allowlist as pending.

A machine installed with `--no-allow-free-verbs` (or an interactive "no") used
to have its `permissions.pending` recomputed from the settings file on every
later `--refresh`, which `update` spawns after each version swap — a settled
decline had no persisted trace, so the full free-verb rule set came back as
"NOT written; run `tenjin install`" forever (tenjin-agent#234). A decline now
persists `install.freeVerbsDeclined` in config.json, and `--refresh` reads it
instead of recomputing from the settings file; it is cleared the next time an
install actually wires the allowlist, so a later legitimate grant is never
shadowed by a stale decline.
