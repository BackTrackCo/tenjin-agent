---
'tenjin-cli': patch
---

A router lookup the spend policy refused (`needs_approval`) is no longer written
to `~/.tenjin/paid/ledger.jsonl` as a paid call, and its result no longer reports
the refused price as a cost. Nothing was signed, so there is nothing to record or
reconcile.
