# A parse wrapped in `catch` returns a default, so the figure you are debugging was never computed

A helper that reads a short written form, a duration, a size, a range, and wraps the read in `try`/`catch` with a module default in the `catch`, has two exits that look identical from the outside. Destructuring the result of a `String.prototype.match` that found nothing throws a `TypeError`; the `catch` turns that into a number of the right shape and the right units, and the caller divides by it. Nothing is thrown, nothing is logged, and the figure that comes back is plausible.

So the arithmetic above it is confirmed every time it is read, because it is correct. What separates the cases that fail from the cases that pass is a property of the input rather than of the code: the ones written in a form the parse does not accept. That property is easy to miss, because a default that happens to equal what one input asked for makes that input pass too, and one passing member breaks the pattern the rest of them form.

Ask the helper directly rather than reading it. Call it once per input the run names and compare each answer with the module default. An input that comes back as the default exactly is an input that was never parsed, and the set of those inputs is the shape of the defect.

Widening the default is not available: two inputs that want different values cannot both be served by one. Either the parse accepts the forms the inputs actually use, or the failure leaves the helper instead of being converted into a number. Which forms the inputs use, and what each expects, come only from a run.
