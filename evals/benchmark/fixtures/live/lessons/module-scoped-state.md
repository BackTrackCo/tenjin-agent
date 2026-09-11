# State declared at module scope outlives the call, so the second answer is a discount on the first

A module body runs once per module instance. A `Set`, `Map`, counter or cache declared there belongs to the process, not to the call, and every call in that process shares it. A helper written for one batch, whose comment says "the log" or "the batch" in the singular, quietly means everything this process has seen so far, and the comment is what makes the declaration read as deliberate.

The first case is therefore right, which proves the function. Every case after it is wrong by an amount that depends on what ran before it, so the error grows or shrinks with position and reads as an off-by-one, a bad comparison, or a case that was written wrong. The strongest evidence of all points the wrong way: run the failing case on its own and it is green, which is exactly what a correct function and a bad expectation would look like.

Two calls settle it without reading anything. Call the reported function twice with the same argument in one process. A function whose second answer differs from its first is holding state, and the reading that follows is a search for where, not an argument about whether.

The state has to be created inside the call, or reset at its edge, so that a call is a function of its argument alone. Per-file isolation in a runner hides this rather than fixing it: the cases in one file share one module instance, which is why the run disagrees with the single-case probe. What each case expects still comes only from a run.
