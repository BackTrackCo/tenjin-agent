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
reported even on a machine sitting on an old decline — and it never survives an
actual grant: it is cleared the moment an install wires the allowlist, or finds
it already fully satisfied, so a later legitimate grant is never shadowed by a
stale decline.
