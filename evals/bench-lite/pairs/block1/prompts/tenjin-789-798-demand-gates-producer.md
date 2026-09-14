# The headline demand number counts questions no list will show

The number we publish for how much agent demand the marketplace saw never consulted the
veto the question lists apply. An operator hides a junk question from every list, the lists
obey, and the headline total keeps counting it, so a reader sees a figure they cannot
reconcile against anything on the page. The reason it stayed invisible is that the two
halves read different tables: the half the veto covers is unioned in from a source the
lists never render, so a vetoed row vanished from every list while still moving the total
with nowhere for a reader to look.

Apply the existing veto to the half that has one, through the seam that already exists
rather than a new rule of your own. The module that owns these predicates opens by saying
that a gate with a second home is how it goes missing on one surface, and that warning is
the point: if you find yourself writing a second copy of the veto next to the count,
delete it and reach for the one that is already there. Do not add a new list, a new column
or a new operator knob; the operator-facing lever is data and already works.

There is one genuine trap. The veto compares a normalized question, and that value is
absent for a request that stored no text at all. Such a row is missing telemetry rather
than a synthetic event, so it must stay counted; without a guard for the absent case the
existing cases silently halve. Measure the effect on production before and after rather
than estimating it, and prove the new predicate is not vacuous by removing it and watching
the count change. This is not full parity with the lists, and say so in a comment: the
lists also require a publishable shape and a displayable length, and their window is
shorter, so a counted row can still be unlistable. Run only the focused test file you touch;
it needs Docker.
