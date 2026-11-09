---
'tenjin-cli': patch
---

Routing pays the fee the router quotes for each answer, up to $0.25, in place of a flat $0.003 ceiling. When the router offers both an answer's own quote and its fixed $0.003 quote, Tenjin pays the answer's own quote, below $0.003 too, and pays the fixed quote only when it is the only offer. A dear answer that the routing funds cannot cover gets its deposit on the same call, so the offer is kept; a wallet that cannot fund that deposit pays nothing for the answer, and the next answer is still asked for. Deposits stay at most $0.25 and count toward your spend limits once, when sent; no spend limit changes. `tenjin status` shows the funds set aside for routing in dollars rather than as calls left.
