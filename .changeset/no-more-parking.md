---
'tenjin-cli': minor
---

Remove the candidate pen. Implements #133.

A publish decision is made once. Parking a draft "for later" turned that into a
backlog nobody returned to, and the reminder that would have resurfaced it is the
repeat-nag class this CLI stopped emitting — so rather than warn about the pen for
a release, it is gone now, in the same release as the skills that stopped teaching
it.

Removed: `tenjin candidate add`, `list`, and `drop`; the `tenjin publish
--candidate` path; the local candidate store; the `tenjin_candidate` MCP tool;
and the `Bash(tenjin candidate list:*)` line from the recommended free-verb
allowlist, which is now eight rules rather than nine. A re-run of `tenjin install`
does not remove an allowlist line an earlier version wrote, because install only
ever appends — delete that line by hand if you want it gone.

The Stop hook's open-loop reminder and the MISS `publishBack` hint keep the shape
they took when parking was deprecated: publish it back, or close the loop with
`tenjin outcome --search-id <id> --status regenerated`. Nothing is saved to come
back to, and the outcome report is what marks the search resolved so the reminder
never raises it again.

**Anything already in `~/.tenjin/candidates/` is left exactly where it is.** It is
your content, so nothing deletes it and `tenjin uninstall` will not either — but
nothing reads it any more, so a draft you want is a file to open at
`~/.tenjin/candidates/<id>/draft.md` and publish with `tenjin publish <file.md>`.
The `candidate` resolution value stays parseable in the search ledger so an older
`searches.json` still loads; nothing writes it now.
