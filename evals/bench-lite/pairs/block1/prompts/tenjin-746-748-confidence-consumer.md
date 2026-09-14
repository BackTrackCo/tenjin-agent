# The paid answer endpoint must not charge for a weak match

`POST /api/answer` sells a synthesis sight-unseen: if retrieval returns anything at all, the
caller gets a 402 and pays. The miss-versus-candidates line is currently "did retrieval return
zero rows". That was defensible when we indexed excerpts, but we now index whole bodies and the
keyword leg is OR-joined, so a single incidental word inside a long paid piece is enough to
retrieve it. The route will happily charge for a synthesis over a piece that merely shares a
word with the question, and the caller has no way to know before paying. Gate what may be quoted
on the same per-candidate match-strength signal the shortlist route already publishes, so an
agent reading the shortlist and this route can never disagree about how good a match is.

## Contract

The observable interface the tests assert. Implementation is yours.

**What may be quoted**

- Only a strong enough semantic match may be quoted. A hit the keyword leg alone found never
  qualifies, however well its text matches.
- When no dense leg ran at all (no embedder configured, embedding budget spent, provider down)
  nothing qualifies, and the request is a free miss rather than a guess with a price on it.
- A row retrieval kept but the gate refuses is a free miss: the response is `200` with
  `decision === 'MISS'`, no `PAYMENT-REQUIRED` response header, `body.sources` and `body.price`
  both `undefined`, and no row written to the `answers` table.
- The gated request is still recorded as demand: the `lookups` row addressed by `body.searchId`
  has `decision === 'miss'`. Telemetry records what the CALLER got, so the gate runs above the
  demand row.
- A quoted request is `402` and its body carries `sources`, an array of objects each with a
  `resourceId`.

**Where the refusal happens**

- `runRetrieval` in `lib/search/retrieve/candidates.ts` gains an options key
  `qualify?: (row: LookupRow, calibration: SearchCalibration) => boolean`, applied to the fused,
  ranked list BEFORE the top-K cut and before the eligible/ineligible tier partition, so a
  refused row never occupies a slot a qualifying row would have taken. Every existing option
  (`scope`, `diversify`, `includeIneligible`) keeps its meaning; callers that pass no `qualify`
  are unaffected. The predicate receives the calibration that actually answered
  (`'lexical-v1'` on both the no-embedding and the dense-failure paths, `'hybrid-v1'` on the
  fused path).
- The test drives this directly: with five lexical-only pieces outranking three qualifying ones
  under RRF and `limit` at its default, ALL THREE qualifying pieces must come back in `sources`,
  not the two that happened to survive the cut. The five pieces use distinct creator handles, so
  the per-creator cap cannot be what limits the count.
- The route applies the gate before any payment machinery is built for the request.

**The route's own surface**

- `createAnswerHandler` keeps its positional signature and its fourth positional parameter is the
  `EmbeddingProvider | null` the route retrieves with; the suite passes a deterministic stub
  there and a case passes `null` deliberately to drive the no-dense-leg path.
- A successful answer now reports `calibration: 'hybrid-v1'`, because the suite drives a real
  (stubbed) dense leg. `answer`, `model`, `generatedAt` and `citations` keep their existing
  shapes.
- The 402 quote body's `hint` says a question nothing matches strongly enough returns a free MISS
  and is never charged.
- Update the route description, `lib/agent-docs.ts`, the OpenAPI text and the MCP tool text so
  they say a 402 follows a strong enough match rather than any match.
- Nothing about the shortlist route changes: it still returns weak rows, labelled, and it does
  not charge.

**One test-only export**

- The oracle imports, BY NAME, one currently module-private constant from `@/lib/search/project`
  and places fixture vectors relative to it. Widen exactly that binding to `export` without
  changing its value or its meaning, and without exporting anything else from that module that
  is not already exported. The import error names the binding if you have not found it.
- The oracle also imports `DENSE_COSINE_SIMILARITY_FLOOR` from `@/lib/search`, which is already
  exported, and asserts that the retrieval floor sits strictly below that constant. Do not move
  either number.

## Constraints

Work within `app/` and `lib/`. Preserve every existing interface and all unrelated behaviour.
Do not change dependencies. Run only the focused test files for this change:
`tests/integration/answer.test.ts` and `tests/integration/lookup-hybrid.test.ts`. Both are in the
integration lane and need Docker; the answer tests need a deterministic stub embedder driving a
real dense leg rather than a null one, supplied at
`tests/integration/_support/embedder.ts`. Do not run the full suite.
