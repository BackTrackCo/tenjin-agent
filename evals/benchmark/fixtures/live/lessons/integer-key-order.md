# A plain object never keeps insertion order for keys that look like whole numbers

An object's own keys come back in two groups, never one: every key that is a canonical array index first, ascending as a number, and then every other key in the order it was added. `Object.keys`, `Object.entries`, `for...in`, `JSON.stringify` and object spread all read that order, so a mapping built by assigning into `{}` under labels like `'7'` and `'23'` is re-ordered on the way out and nothing in between can be blamed for it.

This survives a careful reading because every value is right. Only the order is wrong, so the search goes to the code that computes the values, which keeps checking out. It also survives a scratch probe: the reordering appears only when the keys are integer-like and their first appearance is not already ascending, so a hand-typed probe under `'a'` and `'b'`, or under labels that happen to arrive in ascending order, comes back in insertion order and clears the object.

Order of first appearance has to be carried by something that keeps it, a `Map` or an array of pairs. It cannot be recovered afterwards: no sort of the labels reproduces first appearance in general, and a set of labels can even reorder partially, because `'07'`, `'1.0'` and anything past 2^32-2 are not array indices and do stay in insertion order.

This is `OrdinaryOwnPropertyKeys`, specified since ES2015 and the same on every engine and every Node version, so it is a standing rule rather than a regression to bump past. Which labels a run holds, and what order it expects them in, still come only from a run.
