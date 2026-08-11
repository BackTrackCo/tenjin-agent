---
'tenjin-cli': minor
---

Stop the CLI recommending a holding pen nobody comes back to.

A publish decision is made once. The skills stopped teaching parking in the same
release as this change, and these are the CLI strings that were still saying the
opposite at the same moment: an agent that read the skill ("never park") and then
read the MISS output or the turn-end nag ("park it") got two shipped surfaces
disagreeing on the exact decision the skill governs. They now agree, and both
land together.

The Stop hook's open-loop reminder and the MISS `publishBack` hint (its JSON arm
and its stderr twin) drop the park arm for a DECLINE arm: `tenjin outcome
--search-id <id> --status regenerated`. That is the honest close — nothing is
saved to return to — and it is also what marks the search resolved, so the
reminder never raises it again, which a parked draft never did. The
`publishBack` object's `park` key becomes `decline`. `HOOK_SCRIPT_VERSION` goes
to 12, so a `tenjin install` re-run refreshes the scripts.

`tenjin search` no longer prints the "N candidate(s) parked (M stale >7d)" line
on a MISS. A reminder that re-raises work nobody chose to come back to is the
repeat-nag class this CLI stopped emitting, and it was firing on every MISS.

`tenjin candidate add` and `tenjin candidate drop` print a deprecation notice on
stderr and keep working for one release; the notice names both real options
(publish it, or close the loop). `candidate list` is deliberately quiet, because
it is the surface an operator needs to see and empty a pen they already have, and
publishing an existing candidate keeps working until removal. The notice is
stderr-only, so a `--json` envelope is byte-identical to before. The removal
itself — every candidate verb, the store, and each leftover mention — is tracked
in issue #133 and ships next release; residual pen files on disk are operator
property and will not be deleted.

`tenjin uninstall`'s kept-items list drops the "parked candidates" phrasing for
wording that does not imply an ongoing feature, while still promising the same
thing: whatever you parked is still yours and uninstall will not touch it.
