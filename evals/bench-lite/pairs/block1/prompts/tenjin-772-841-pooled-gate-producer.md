# The decision search can no longer say no

The decision view's verdict has only ever meant "retrieval returned zero rows". No relevance rule
was ever written; what acted as one was retrieval being narrow, and three recent changes removed
that narrowness, so one incidental word inside a long paid piece is now enough to retrieve it.
Every client that keys on a miss therefore never falls through: a probe of ten team-mode lookups
asked the public shelf zero times, and a prompt asking for a haiku about ducks came back with
three candidates. Give the decision view a relevance floor, and score each candidate on its own
evidence rather than on whether it made the dense leg's result window.

## Contract

The observable behaviour the tests assert. Implementation is yours.

**The floor**

- The decision view refuses a candidate that is neither semantically close on its own nor
  corroborated. In terms of the fields the shortlist already publishes: a row whose `confidence`
  is `'low'` AND whose `corroborated` is not `true` is refused. When nothing better exists the
  shortlist is empty, `matched` is `0` and `decision` is `MISS`.
- The refusal happens inside retrieval at the existing per-row `qualify` seam, applied before the
  top-K cut, so a refused row never occupies a slot a qualifying row would have taken.
- The fused path only. A response with no dense leg passes through unfloored and says so:
  `calibration === 'lexical-v1'`, and a lexical word match still returns `matched: 1`.
- The display view is untouched and still lists a word match. The plain article listing is
  untouched. No existing bucket or floor constant is retuned.

**What "the keyword leg independently matched it" may key on**

- `corroborated` must NOT key on membership in the dense leg's result window. Export from
  `lib/search/project.ts` a per-row predicate over the row's own similarity —
  `semanticallyClose(row)`, true when `row.similarity !== undefined` and
  `row.similarity >= DENSE_COSINE_SIMILARITY_FLOOR` — and derive `corroborated` as
  `row.postHit && semanticallyClose(row)`.
- `deriveConfidence` stops reading `semanticHit` and buckets on `row.similarity` alone; a row with
  no similarity at all is `'low'`.
- `semanticHit` stays exactly what it was — membership in the dense leg's top-`FUSION_LIMIT`
  window, which telemetry counts as the beam-contribution signal — and must not become a gate. It
  still appears in `matchReasons`.
- `buildMatchReasons(row)` names `'semantic match'` when `row.semanticHit` is true OR
  `semanticallyClose(row)` is true, so a row the beam did not carry but whose own cosine clears
  the floor still reads as a semantic match. `'title/excerpt lexical match'` is unchanged and
  comes first.
- Export `deriveConfidence` and `deriveCorroborated` from `lib/search/project.ts` so the floor,
  which lives in `lib/search/index.ts`, can read them.

**Scoring a row on its own evidence**

- Every fused row gets a `similarity`: from the dense leg where the window carried the row,
  otherwise backfilled by one exact per-post scan over the lexical leg's post ids, grouped per
  post and taking the best chunk, producing the same number the dense leg would have produced.
- The backfill is issued CONCURRENTLY with the dense leg, so it costs no extra round trip.
- The test that pins this seeds `FUSION_LIMIT` decoy pieces at cosine 1 with no shared word, then
  one target piece that shares a title word and sits at a medium cosine. The target must come
  back with `confidence: 'medium'`, `corroborated: true` and
  `matchReasons` equal to `['title/excerpt lexical match', 'semantic match']`, even though the
  window is full of decoys. `FUSION_LIMIT` is already exported from
  `lib/search/retrieve/candidates.ts`.

**The fresh-piece exemption**

- `LookupRow` gains `awaitingEmbed?: boolean`, projected by the lexical leg as the embeddings
  sweep's own reconciliation predicate bounded to a day: the post's `updated_at` IS DISTINCT FROM
  its `content_embedded_at` AND `updated_at > now() - interval '1 day'`. Absent reads as false.
- A row is exempt from the floor only when `awaitingEmbed` is true AND it matched lexically AND it
  has NO similarity at all. The four cases the test drives:
  a never-embedded piece published now returns `matched: 1` with `confidence: 'low'`;
  the same piece with `updated_at` set two days back returns `matched: 0`;
  a piece the sweep reconciled to zero chunks (`content_embedded_at` set equal to `updated_at`)
  returns `matched: 0`;
  an EMBEDDED piece whose vectors are far from the query, then touched by a metadata-only edit
  (price change bumping `updated_at`), returns `matched: 0` — a piece that has vectors is always
  judged on them, or the exemption becomes renewable by touching the row.

**Other behaviour the focused tests pin**

- A lexical-only row inside a hybrid response is absent from the shortlist rather than ranked
  last: with a both-legs post, a dense-only post and a lexical-only post, the returned id set is
  exactly the first two.
- A dense hit `0.02` above the dense floor whose title shares a query word survives (corroborated)
  and its `matchReasons` are `['title/excerpt lexical match', 'semantic match']`; the same
  geometry `0.02` BELOW the floor is a `MISS` that still reports `calibration: 'hybrid-v1'`.
- Update the machine-facing docs and MCP tool descriptions that the floor falsifies.

## Constraints

Work within `lib/`, `app/` and `scripts/`. Preserve every existing interface and all unrelated
behaviour; do not retune any existing threshold. Do not change dependencies. Run only the focused
test files for this change: `tests/integration/search-floor.test.ts` and
`tests/integration/lookup-hybrid.test.ts`. Both need Docker. Do not run the full suite.
