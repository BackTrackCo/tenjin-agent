---
'tenjin-cli': patch
---

Tune the `tenjin-search` trigger description against its own eval, taking the
trigger set from 18/20 to 20/20 with every positive unchanged. That 20/20 is
in-sample: the description was tuned against those twenty queries and then scored
on them, and the keyless runner has no holdout, so read it as a fit rather than
as out-of-sample validation. The costly gate is
now part of the trigger rather than the subject ("version-specific compatibility
someone had to install and run to settle"), a new clause skips what the docs
answer in one line even when the question names versions, and the skip list names
the excuse the debugging over-fire was winning on: skip implementing, reviewing,
or debugging the thing in front of you, however famous the gotcha behind it.
