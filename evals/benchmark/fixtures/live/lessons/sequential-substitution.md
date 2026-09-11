# Replacements applied in sequence run over what the earlier ones wrote

A loop that reassigns the output once per rule hands the growing output to the next rule. Text a rule inserts is text a later rule can match, so the result is not a function of the input and the rules; it is a function of the input, the rules, and the order they run in. The loop is three lines and every line is correct on its own, which is why it keeps being confirmed.

The inputs that break it are the ones whose replacement text contains something a later rule matches, and that is a property of the data rather than of the code. Inputs without that property are the majority and they pass, so the run shows a mostly green file with no line to blame, and the two sides of the diff differ by a fragment that appears nowhere in the input.

Reordering is the obvious repair and it is not available. If one entry's text names a second, the first has to run after the second; if that second's text names the first, the order has to be the other way round. A set holding both has no order that serves them, so an order that fixes one case makes a case that was passing fail, and the repair reads as progress while it trades one failure for another.

What removes the class rather than an instance is a single traversal that decides each slot from the values and never re-reads what it has written, so the output is never an input. Which slots each case carries, and what it expects where the values hold no entry, come only from a run.
