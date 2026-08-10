---
'tenjin-cli': patch
---

Make `publish.mode` actually govern what happens to a finished draft. The skills
told the agent that any doubt on the semantic-safety pass parks the piece, and
that rule read as absolute, so a rights-clean draft with two unverified vendor
claims got parked in `auto` — a quality worry silently overrode a mode the
operator had set, and the operator heard nothing about it.

Doubt is now two judgments with different answers. Privacy and rights doubt —
private context, third-party data, rights, competitor reconstruction — still
parks in every mode; that half is deliberately unchanged and stays conservative,
because parked is recoverable and published is not. Quality doubt is the agent's
own uncertainty about an unverified claim or a missing polish pass, and the
resolved mode decides it: `review` was asking anyway, `auto` surfaces it to the
user as the same one-click yes/no the scan findings already use, and `full-auto`
hedges the claim honestly in the piece — named as unverified, with a date — and
publishes. Parking on quality is not available in `full-auto`.

Every park, in any mode, now has to be reported in the agent's final message with
the candidate id. A park nobody is told about is indistinguishable from the work
never happening, which is what made the original failure invisible.

The mode is resolved per run, so `tenjin config set publish.mode <mode>` changes
this behavior on the next command with nothing to re-install and no session to
restart.
