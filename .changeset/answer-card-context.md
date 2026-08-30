---
'tenjin-cli': patch
---

Correct what answer-card completeness does and does not affect. Card prose is not a
retrieval input: no card text makes a piece match a query better. Completeness still
decides placement, so an incomplete card ranks below every complete one within the
retrieved window and `POST /api/answer` will not cite it, while a card-less piece
additionally fails any `freshWithin` or `appliesTo` filter. CLI receipts, installed
publishing guidance, and the plain-HTTP skill now state that distinction instead of
describing completeness as cosmetic.
