---
'tenjin-cli': patch
---

`tenjin install --refresh` no longer re-reports a declined allowlist as pending.

A machine installed with `--no-allow-free-verbs` (or an interactive "no") used
to have its `permissions.pending` recomputed from the settings file on every
later `--refresh`, which `update` spawns after each version swap — a settled
decline had no persisted trace, so the full free-verb rule set came back as
"NOT written; run `tenjin install`" forever (tenjin-agent#234). A decline now
persists the EXACT rules that were pending in `install.freeVerbsDeclined` (a
list, not a flag), and `--refresh` subtracts that list from what it recomputes
instead of nagging about all of it forever. Per-rule rather than a single
suppress-everything switch, so a later version's genuinely new rule still gets
reported even on a machine sitting on an old decline.

This is a nag-silencer, not a consent record: it clears whenever an install
actually wires the allowlist, whether that is an explicit grant, a headless
settle with nobody there to answer, or finding the allowlist already fully
satisfied — installing Tenjin is the operator's consent, per existing policy,
so any of those is enough to retire a stale decline. It stays recorded when the
write itself is refused (an unreadable or concurrently-changed settings file):
the next refresh still honors it instead of re-nagging about rules the
operator already declined.
