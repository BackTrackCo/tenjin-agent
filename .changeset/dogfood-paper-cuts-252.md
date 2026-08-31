---
'tenjin-cli': patch
---

Five dogfooding paper cuts from `main` (tenjin-agent#252): `inspect`/`read` now resolve an id straight out of `tenjin sync`'s own output, synced pairing bodies drop the full raw command in favor of its head, `tenjin doctor` warns when installed hook scripts have gone stale (or unreadable) since the last `tenjin install`, `tenjin push status` shows how stale a cached lookup-stat answer is, and `tenjin state query "<sql>"` gives WAL-mode `state.db` a read-only inspection path that does not hit the standalone `sqlite3 -readonly` binary's "unable to open database file (14)" failure.
