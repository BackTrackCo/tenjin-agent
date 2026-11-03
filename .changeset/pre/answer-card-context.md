---
'tenjin-cli': patch
---

Treat answer-card completeness as public buyer context rather than a retrieval or
answer-eligibility signal. Card prose and completeness do not change relevance,
rank or placement, candidacy, or whether `POST /api/answer` may use a piece. Explicit
`freshWithin` and `appliesTo` filters still require matching stored claims, and a
present `validUntil` remains an expiry gate. CLI receipts, installed publishing
guidance now state that distinction. The vendored plain-HTTP skill must be resynced
from canonical server output after the companion server release is deployed.
