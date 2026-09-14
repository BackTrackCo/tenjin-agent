# Close the last two gaps in the demand count

Two holes are left in the headline demand number after the veto work. The first is that
only one of the two halves the number unions ever applies an operator veto at all, so a
term an operator hid from the term lists still inflates the total from the other side. The
second is that neither half can apply the question-shape rule the question lists use, so a
canonical test string or a question with no letters in it counts as real agent demand.

Fix both. The half with no veto gets the operator veto that the term lists already use.
For the shape rule, the existing predicate is TypeScript and runs on a value in memory,
while this count is computed entirely in the database, so it needs a database-side twin.
Build the twin off the same pattern source the TypeScript one uses rather than retyping the
rule, since two hand-written copies of the same rule are how they drift, and keep it beside
its twin in the module that owns these predicates. Then pin the two forms against each
other with a test that runs every case the TypeScript predicate's own unit suite covers
through the database form and asserts they agree.

Both new predicates go in the same position and with the same handling as the veto that is
already there; look at how that one is written before you write yours, because the reason
for its shape is not obvious and the existing cases will quietly change their counts if you
miss it. Watch the arithmetic when you write fixtures: each half of the union is gated on
how many distinct requesters it saw, so a fixture that removes a row can drop its whole
half below that gate and pass for the wrong reason. Expect one real disagreement between
the two forms around how each counts the length of a string, and settle it in favour of
what the database does. Run only the focused test files you touch; one needs Docker.
