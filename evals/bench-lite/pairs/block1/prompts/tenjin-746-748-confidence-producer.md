# Publish a coarse match-strength signal on the decision view

The sidecar push hooks need to know whether the top result is actually a good match before they
put a finding in front of an agent, and before the research arm denies a web search in its
favour. Today the wire carries nothing they can use, so the hook guesses with word overlap
against the question, which is wrong often and opaque when it is wrong. Give the decision view
a coarse, server-derived signal of how strong each candidate's match is, derived from the
semantic leg's own similarity rather than from the fused ranking score or from lexical
agreement, and keep whether the lexical leg agreed as a separate fact. The existing boundary
that keeps body-derived per-result numbers off responses still holds: no raw number may reach
the wire.

## Contract

The observable interface the tests assert. Implementation is yours.

**The candidate fields**

- `SearchCandidate` in `lib/search/project.ts` gains exactly two new fields:
  `confidence?: 'high' | 'medium' | 'low'` and `corroborated?: boolean`.
- Both are OMITTED (the key is absent from the object, so `'confidence' in candidate === false`),
  never `null` and never `undefined`-valued, whenever they do not apply.
- `confidence` buckets the DENSE leg's own cosine similarity for that row:
  `>= 0.62` is `'high'`, `>= 0.52` is `'medium'`, anything else is `'low'`. Both comparisons are
  inclusive, so a row at exactly `0.62` is `'high'` and one at exactly `0.52` is `'medium'`.
- A non-finite similarity (`NaN`) buckets `'low'` explicitly rather than falling through both
  comparisons.
- A row inside a fused response that the dense leg did not contribute at all buckets `'low'`.
- `confidence` does NOT cap at `'medium'` when the lexical leg also matched: a both-legs row at
  similarity `0.7` is `'high'` with `corroborated: true`, and a dense-only row at `0.7` is
  `'high'` with `corroborated: false`. The two fields vary independently.
- `corroborated` is true only when the row matched lexically (`row.postHit`) AND
  `row.semanticHit === true`.
- Presence gate for BOTH fields: the caller's `calibration` argument is `'hybrid-v1'` AND the row
  carries a fused score. A row carrying a score whose calibration is `'lexical-v1'` omits both,
  so the gate reads `calibration`, not just `row.score`. A plain lexical-only row (no score)
  omits both.
- `buildSearchResponse(rows, searchId, calibration?, browse?)` keeps its existing signature and
  its existing behaviour for every other field.

**The fusion seam these fields read**

- `fuseLookups(lexical, dense, limit)` sets an RRF `score` on EVERY row it returns, including a
  lexical-only one, and every such score is `> 0`.
- It copies `similarity` onto a row only where the dense leg placed it, read back off the `dense`
  array rather than off the merged row: a post both legs found keeps the primary (lexical) row
  object, which never carried a similarity. So for `lexical = [both, lexOnly]`,
  `dense = [both@0.91, denseOnly@0.82]`, the fused rows have `similarity` `0.91`, `undefined` and
  `0.82` respectively.
- `fuseByRank(primary, secondary)` returns `{ row, inSecondary, score }` per entry.
- `LookupRow` in `lib/search/types.ts` carries `score?: number` and `similarity?: number`. Both
  are INTERNAL: neither may ever be serialized.

**The wire**

- A decision-view candidate is the ONLY surface that may carry `confidence` or `corroborated`.
  A dense hit on `POST /api/agent/search` (v2, `body.candidates[0]`) and on the v3 decision
  response (`body.items[0]`) carries `confidence` in `['high','medium','low']` and a boolean
  `corroborated`.
- The display view, the suggest view and the MISS browse tail must carry NEITHER field anywhere
  in the response body, at any depth.
- No response, on any surface, may carry a key named `score`, `similarity`, `distance`,
  `relevance`, `snippet` or any other chunk-text or chunk-offset field, at any depth. A browse
  item carries none of `confidence`, `score`, `similarity`.
- A lexical-only wire response reports `calibration === 'lexical-v1'` and its candidates carry
  neither field.

**OpenAPI (runtime drift guard)**

- `components.schemas.SearchCandidate.properties` gains exactly the two keys `confidence` (a
  string enum `['high','medium','low']`) and `corroborated` (a boolean), and NOTHING else.
- `SearchCandidate.required` must list every candidate property EXCEPT those two, and must
  include neither `'confidence'` nor `'corroborated'`.
- The test binds the schema to the runtime: the key set of a candidate produced by
  `buildSearchResponse` on a NON-fused row must equal the schema's properties minus those two
  keys, and the key set of a candidate produced from a fused row
  (`{ ...row, semanticHit: true, score: 0.05, similarity: 0.6 }` under `'hybrid-v1'`) must equal
  the schema's full property key set. The nested `creator` object stays bound the same way.
- Update the agent-facing docs (`lib/agent-docs.ts`), the MCP tool text (`lib/mcp/server.ts`) and
  the OpenAPI descriptions so they describe the new fields and their presence rule.

## Constraints

Work within `lib/`. Preserve every existing interface and all unrelated behaviour: no ranking
change, no budget change, no change to when a query misses, no retune of any existing threshold.
Do not change dependencies. Run only the focused test files for this change:
`lib/lookup.test.ts`, `lib/search-response.test.ts`, `lib/openapi.test.ts` and
`tests/integration/search-route-envelopes.test.ts`. The integration lane needs Docker. Do not
run the full suite.
