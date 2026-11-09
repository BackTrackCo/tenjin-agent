---
'tenjin-cli': patch
---

Routing pays the fee the router quotes for each answer, up to $0.25, in place of a flat $0.003 ceiling. When the router offers both an answer's own quote and its fixed $0.003 quote, Tenjin pays the answer's own quote, below $0.003 too, and pays the fixed quote only when it is the only offer. A dear answer that the routing funds cannot cover gets its deposit on the same call, so the offer is kept; a wallet that cannot fund that deposit pays nothing for the answer, and the next answer is still asked for. Deposits stay at most $0.25 and count toward your spend limits once, when sent; no spend limit changes. `tenjin status` shows the funds set aside for routing in dollars rather than as calls left.

When the wallet cannot fund a routing answer, the notice now says Tenjin could not pay for that answer and that answers needing no payment can still work, instead of saying Tenjin stopped routing. The install question, the request tool's instructions, the deposit line and the docs describe the fee as quoted for each answer, at most $0.25, with no fee shown on offers.

`tenjin status` and `tenjin wallet balance` show what routing has cost so far, beside the funds set aside for it: the deposits sent less the credit they still hold, a local estimate from the routing channel files with no extra network read.

An install that approved the old fixed fee is told the new routing terms once, on its first routing call after the update; it is not asked, and no spend limit changes. An install whose person approves limits on the new terms hears nothing.
