# Long pieces are clearing the semantic gate on one lucky passage

A piece's semantic score is the best of its chunks, and every gate that reads a semantic number
reads that one. The maximum over N chunks rises with N by construction, so a twenty-chunk piece
gets twenty draws at clearing a fixed threshold where a two-chunk piece gets two. The result is a
long generic piece sitting at rank one on queries a short focused piece answers better, and
clearing the strongest bar while doing it. Make the gates read a length-aware number instead, and
compute it exactly rather than from whatever the semantic beam happened to carry.

## Contract

The observable interface the tests assert. Implementation is yours.

**The new per-row numbers**

- `LookupRow` in `lib/search/types.ts` gains two fields: `pooledSimilarity?: number` and
  `chunkCount?: number`. Both are INTERNAL and neither may ever be serialized.
- `pooledSimilarity` is the MEAN of the piece's best three chunk cosines, or of all of them when
  it has fewer than three. `similarity` keeps its current meaning, the maximum, because that is
  what ranks.
- It is computed EXACTLY, over the piece's own vectors, not from the rows the semantic beam
  carried. The beam holds only some of a long piece's chunks and the ones it left behind are
  further away than its worst, so a beam-based mean overestimates for exactly the pieces this
  targets. It runs after fusion over a bounded number of rows.
- `chunkCount` carries the piece's chunk count along for the feature-logging work that follows.

**Which readers move onto it**

- Every gate that judges how good a match is reads `pooledSimilarity`: the confidence buckets,
  the corroboration predicate, and the delivery bar. Ordering keeps `similarity`, and so does the
  semantic leg's entry filter. The thresholds themselves do not move.
- A row with NO `pooledSimilarity` is `'low'`, whatever its `similarity` says. Both
  `candidateOf(row({ postHit: true }))` and
  `candidateOf(row({ postHit: true, similarity: 0.99 }))` must bucket `'low'`.
- The field that records which rows the semantic leg's own window carried (`semanticHit`) does not
  move and stays in `matchReasons`. The truth table the test pins, all rows fused under
  `'hybrid-v1'` with `score: 0.05`:

  - `{ postHit: true, semanticHit: true, similarity: 0.71, pooledSimilarity: 0.4, chunkCount: 20 }`
    gives `confidence: 'low'`, `corroborated: false`, `strong: false`, and `matchReasons` equal to
    `['identifier/title/excerpt lexical match', 'semantic match']`.
  - the same row WITHOUT `semanticHit` gives `matchReasons` equal to
    `['identifier/title/excerpt lexical match']`.
  - `{ postHit: true, semanticHit: true, similarity: 0.71, pooledSimilarity: 0.69, chunkCount: 2 }`
    gives `confidence: 'high'`, `corroborated: true`, `strong: true`.
  - the existing boundary cases keep their answers when expressed in the new field:
    `pooledSimilarity` `0.7` is `'high'`, `0.55` is `'medium'`, `0.3` is `'low'`, `0.62` is
    `'high'`, `0.52` is `'medium'`, `NaN` is `'low'`, and a row under `'lexical-v1'` omits both
    `confidence` and `corroborated` however high its pooled score.
  - `strong` is true only when corroborated and confidence is not `'low'`: corroborated at
    `CONFIDENCE_MEDIUM_SIMILARITY + 0.05` is `strong: true`; corroborated at the midpoint between
    `DENSE_COSINE_SIMILARITY_FLOOR` and `CONFIDENCE_MEDIUM_SIMILARITY` is `'low'` and
    `strong: false`; uncorroborated at `0.9` is `'high'` and `strong: false`.

**Nothing new reaches a caller**

- A projected candidate carries none of `similarity`, `pooledSimilarity`, `chunkCount`:
  `'pooledSimilarity' in candidate` and `'chunkCount' in candidate` are both `false`, and
  `JSON.stringify(candidate)` does not contain `chunkCount`. Both numbers are derived from paid
  bodies and sit behind the same boundary the raw similarity does.

**End to end**

- Two integration cases drive the same geometry from both ends, using pieces whose chunks each
  carry their own vector. A 20-chunk piece with one chunk at cosine `0.71` and the rest at `0.2`
  pools to `(0.71 + 0.2 + 0.2) / 3`, which is under the dense floor, so nothing corroborates it
  and it is refused from the shortlist: `matched` is `0` and its id is absent.
- Against that same 20-chunk piece, a 2-chunk piece with both chunks at `0.68` must come back as
  the ONLY result, even though the long piece holds the higher maximum.

**The offline evaluation**

- Align `scripts/eval-lookup-recall.ts` with whatever the production path now scores. Its ranked
  rows carry BOTH numbers: each entry in the `ranked` array is
  `{ slug, postId, similarity, best }`, and `sweepFloor` reads them without changing its existing
  counting semantics.

**Second, unrelated change in the same area**

- `bm25CorpusSize(db)` in `lib/search/retrieve/lexical-rank.ts` counts only DISCOVERABLE rows,
  applying the same visibility predicate every retrieval leg applies (`discoverable()` from
  `./gates`), reached through the creator join it needs, rather than counting every row in
  `posts`. Reuse that predicate rather than restating it.
- The unit test asserts against the rendered SQL of the THIRD statement the ranker issues: it must
  contain `count(*)`, `creators`, `deleted_at` and `status`, and `resolveLexicalRanker(db)` must
  still resolve to `{ ranker: 'bm25', corpusSize: <the count> }`.
- The integration test seeds two published posts by a live creator, a draft, an unlisted piece,
  and a published post by a soft-deleted creator, and expects `bm25CorpusSize` to return `2`.
  `__resetLexicalRankerForTest` clears the 60-second cache between cases.

## Constraints

Work within `lib/` and `scripts/`. Preserve every existing interface and all unrelated behaviour;
no threshold moves, and this is deliberately not a chunk-count correction of the score, which
would shift the whole scale and make "thresholds unchanged" false. Do not change dependencies.
Run only the focused test files for this change: `lib/search/project.test.ts`,
`lib/search-response.test.ts`, `lib/search/retrieve/lexical-rank.test.ts`,
`scripts/eval-lookup-recall.test.ts`, `tests/integration/lookup-hybrid.test.ts` and
`tests/integration/search-keyword-leg.test.ts`. The integration lane needs Docker. Do not run the
full suite.
