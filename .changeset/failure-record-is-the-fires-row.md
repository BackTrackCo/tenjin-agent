---
'tenjin-cli': minor
---

The turn-end ask names the failures this turn HIT, off the ledger row the failure already left.

**Nothing new is stored.** The deleted `pairings` table is replaced by no table at all: `fires` already carries a failure's question key and its masked error line on every outcome, so the row the arm leaves behind is the whole record. The ask reads it back per actor.

**The line asserts nothing.** "You fixed `<line>`" was a claim the machine could not make — behind it was a pairing closed by the next passing run of the same command, which is "something passed later", not "you understood it". The line now says only what the row says: this came up, and the shelf had nothing for it. The publish is offered conditioned on the agent's own judgement, with `--key fingerprint=` filled in when the failure has a fingerprint to file under.

**A failure's question key is composed, not hashed over the line alone.** `sig_v1:<hash>|sig_v1_test:<hash>|line:<hash>`, in that order, and any part may be absent. A key over the error line alone is the same bytes for the identical TypeError in two different files, and the once-per-question gate then serves the second failure the first's cached miss — its fingerprint sitting right there, never resolved. The fingerprints in front of the line hash are what keep them apart.

**A child's failures go to the child, not to the lead** (principle 5): the actor that hit the wall is the one that can explain it. The lead no longer sees what its children hit.

**The ask re-arms on a new failure.** An actor asked at its first stop and then sent into a wall it had to climb out of is asked again, the same way a child's newer finding re-arms the lead. In practice that is the lead's: an already-asked child is on its answer turn and is harvested instead.
