---
'tenjin-cli': patch
---

Routing pays the fee the router quotes for each answer, up to $0.25, in place of a flat $0.003 ceiling. When the router offers both an answer's own quote and its fixed $0.003 quote, Tenjin pays the answer's own quote, even when it is below $0.003, and pays the fixed quote only when it is the only offer. A quote above $0.25 is not paid, and the fixed quote is not used in its place. A dear answer that the routing funds cannot cover gets its deposit on the same call, so the offer is kept; a wallet that cannot fund that deposit pays nothing for the answer, and the next answer is still asked for. Deposits stay at most $0.25 and count toward your spend limits once, when sent; no spend limit changes.

Offers show no fee. `tenjin status` and `tenjin balance` show what routing has cost so far, beside the funds set aside for it, which `tenjin status` now gives in dollars rather than as calls left. The cost is the deposits sent less the credit they still hold, a local estimate from the routing channel files with no extra network read. When the wallet cannot fund a routing answer, the notice says Tenjin could not pay for that answer and that answers needing no payment can still work, in place of saying Tenjin stopped routing. An install that did not approve limits on these terms is told them once, on its first routing call after the update.
