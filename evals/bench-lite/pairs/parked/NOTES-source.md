# Three more producer→consumer pairs

Read-only build: `git show`, `git diff`, `gh pr view` only. No checkout, no test run, no
server started, no PR or issue opened. Sizes are `gh pr view N --json
additions,deletions,changedFiles`; every pair is inside the 900-added-lines / 20-changed-files
limit on both sides.

## Base-commit convention

Same as the earlier set: `base_commit = merge_commit^1`, not `baseRefOid`. Both repos
squash-merge, so `git diff merge^1 merge` is exactly the PR's net effect. All twelve commit
ids were resolved with `git rev-parse` against the local clones.

## The weakness that applies to all three (same as the earlier set)

Each consumer's base commit already contains the producer's merged code, verified with
`git merge-base --is-ancestor`:

| pair | producer merge is ancestor of consumer base | commits in between |
|---|---|---|
| agent 262→273 | yes | 3 |
| tenjin 789→798 | yes | 1 |
| tenjin 772→841 | yes | 34 |

So these measure search cost saved, not information transfer.

---

## Pair 1 — `agent-262-273-condense` (tenjin-agent #262 → #273)

Sizes: producer +850 / 6 files; consumer +687 / 5 files. No Docker. `engines.node >= 24` at
both base commits.

**Shared fact, at the producer merge commit `93263c5`.**
`src/lib/query-condense.ts:29-33, 58-64, 97, 106, 143, 147, 157-159` — one `String.raw`
JavaScript source string delimited by `// condense:begin` / `// condense:end`, spliced into
the generated hook AND evaluated to produce the package's `identifiersOf` and `condense`
exports, with `condenseSource()` handing the raw text back. Caps 12 / 80 / 24 / 400.
`src/lib/push-scripts.ts:1441-1444` — pipeline order: `scrub` runs first, then
`identifiersOf(scrubbed)` and `condense(scrubbed)`. `src/lib/push-scripts.ts:1267` —
`function scrub(text) {`, one argument, located inside the generated script by that exact
signature string. `src/lib/hook-scripts.ts:182-183` — wire field `identifiers`, ≤12 × ≤80.
`src/lib/push-scripts.ts:867` — `identifiers: args.identifiers` in `shelfAsk`, so both
shelves get it.

**Consumer test lines that need it**, `src/lib/push-scripts.test.ts` at `33e8ec6`:
`:1628` (`source.indexOf('function scrub(text, mode)')`), `:1603-1616` (generated block
equals `condenseSource()`, `new Function(body)` agrees with the exports), `:2024-2035` (the
sk-style key must be in neither the condensed query nor the identifiers array — the comment
names #262 explicitly), `:1841` (both fields on the wire). `:58` imports the three symbols,
but that import is already in the file at the consumer's base.

**Prescriptiveness flags.**
- Mild: the `scrub` signature is a string literal in the test, so the agent's exact spelling
  of the second parameter is forced. A failure reads "scrub block not found", which is
  opaque. Flagged, not fixed.
- Mild: the consumer oracle is 2 files, one of which (`hook-scripts.test.ts`) is 7k+ lines
  and covers arms beyond the shared fact. Most of it passes at base.
- Clean on the usual axis: the consumer adds no new module, so nothing in the oracle names a
  file the agent has to create.

**Docker/DB.** None. Node only. Note the trap the earlier set recorded for this repo:
`vitest.config.ts` imports from `./src/lib/push-scripts` and writes a file at config load,
so an edit that breaks that export breaks config loading before any test runs.

**Verdict: KEEP, run first.** The fact is a pipeline ORDER plus a code-generation
convention, which is the hardest class to recover by grepping and the most expensive to get
wrong — getting it wrong here leaks a credential rather than failing an assertion.

---

## Pair 2 — `tenjin-789-798-demand-gates` (tenjin #789 → #798)

Sizes: producer +95 / 2 files; consumer +196 / 4 files. Smallest pair in either set.

**Shared fact, at the producer merge commit `b8a2371`.**
`lib/agent-search-demand.ts:63` — `and (${lookups.generalizedQuery} is null or
${notVetoedQuestion()})`, with `:55-62` explaining that an untexted row is missing telemetry
rather than a synthetic event and stays counted. `:64-70` and `:81-87` — each half of the
union computes its own `>= minSearchers` distinct-requester floor inside its own CTE.
`lib/search/gates.ts:1-4` — "a gate with a second home is how it goes missing on one
surface", which the producer enforced by deleting the second gate it first wrote.
`lib/search/gates.ts:83-84` — `normalizedQuestion()` is the SQL twin of `normalizeQuery`.
`lib/search/gates.ts:124` — `CANONICAL_TEST_QUESTION`, the single pattern source.

**Consumer test lines that need it**, `tests/integration/search-telemetry.test.ts` at
`205a879`: the catalog-veto case seeds FOUR searchers and asserts `{total:4}` → `{total:3}`
at `minSearchers: 3` (its comment: "a fourth searcher so the veto removes a ROW without
dropping the arm under its distinct-requester floor"); the shape-gate case keeps an untexted
row; the parity case runs 16 fixtures through the SQL twin and the TypeScript predicate and
asserts agreement. `lib/search/gates.test.ts:16-21` pins `'😀a'` false and `'😀😀a'` true.

**Prescriptiveness flags.**
- **Moderate:** this consumer prompt carries two deliberate hints the other two do not — it
  tells the agent to look at the existing veto's shape, and it names the length disagreement
  in the abstract. Without the second hint the code-point case is close to unpassable; with
  it, the gap the note is measuring is narrower. This is the weakest of the three on the
  "expensive without the note" axis.
- Mild: the producer at 95 added lines over 2 files is a very small task. Fine for a
  benchmark, but do not describe it as mid-sized.
- The consumer oracle names `publishableQuestionShape` by importing it, which fixes the
  function's identifier and module.

**Docker/DB.** Required. `tests/integration/search-telemetry.test.ts` boots
`pgvector/pgvector:pg16` via testcontainers on both sides. The producer's own verification
note says Postgres `[[:alpha:]]` and `length()` were checked against the TypeScript `\p{L}`
semantics under the suite's `C.UTF-8` locale, so a different collation changes the answer —
the earlier pgvector-collation trap applies.

**Verdict: KEEP, run second.** Cheapest pair to run in either set: 3 oracle files total, one
integration container, 291 added lines across both PRs.

---

## Pair 3 — `tenjin-772-841-pooled-gate` (tenjin #772 → #841)

Sizes: producer +592 / 15 files; consumer +499 / 14 files.

**Shared fact, at the producer merge commit `9309532`.** Which readers judge a match, and
which field does not. `lib/search/project.ts:270` `deriveConfidence`, `:296`
`deriveCorroborated`, `:308` `semanticallyClose`, plus `lib/search/index.ts:88`
`confidentEnough` — four readers of `row.similarity`, three in one module and one in
another. `lib/search/project.ts:251-252` — `CONFIDENCE_HIGH_SIMILARITY = 0.62` private,
`CONFIDENCE_MEDIUM_SIMILARITY = 0.52` exported. `lib/search/types.ts:42-43` — the negative
half: `semanticHit` is window membership and is not a gate; `project.ts:349` uses it only
for a display reason. `lib/search/retrieve/candidates.ts:128` `backfillSimilarity`, `:200`
`FUSION_LIMIT = 50`, `:373` run concurrently with the dense leg, `:288-324` the `qualify`
seam before the top-K cut. `lib/search/types.ts:38` `awaitingEmbed`.

**Consumer test lines that need it**, at `247a920`: `lib/search/project.test.ts:165-216`
(the pooled-gate describe; `semanticHit` must stay in `matchReasons` while the gates move),
`:121-141` (`strong` rewritten to `pooledSimilarity`), `:218-233` (nothing serializes);
`lib/search-response.test.ts:180-257` (every boundary expressed in the new field at 0.62 and
0.52 exactly); `tests/integration/lookup-hybrid.test.ts:651-693` (a 20-chunk piece with the
higher max loses to a 2-chunk piece that pools better, which only passes if the scan is
exact rather than beam-based).

**Prescriptiveness flags.**
- **Severe, producer side:** `scripts/eval-lookup-recall.test.ts` imports `REGISTERS` from
  `./eval/lookup-gold-set`, and #772 is the PR that ADDS the `junk` register with its eight
  prompts to that file. Copying the gold set hands the agent a third of the task's spec.
  Recommendation: drop `scripts/eval-lookup-recall.test.ts` and `scripts/eval/lookup-gold-set.ts`
  from the producer oracle together and use `command_narrowed`. Both files are in the copy
  set with a `leaks` note so the harness can choose; flagged, not fixed.
- **Moderate, consumer side:** two of the six consumer oracle files
  (`lib/search/retrieve/lexical-rank.test.ts`, `tests/integration/search-keyword-leg.test.ts`)
  belong to the PR's second, independent theme — the BM25 corpus count. The shared fact says
  nothing about it. `command_narrowed` drops both and the corresponding paragraph of the
  consumer prompt is the last one, which can be cut.
- Moderate: the oracle spells `pooledSimilarity` and `chunkCount`, fixing both identifiers.
  Same class and size as the constant-name leak already accepted on 746→748.
- The consumer's base sits after the BM25 seam work merged, so `search-keyword-leg.test.ts`
  imports `__resetLexicalRankerForTest` and `bm25CorpusSize`, which exist at base. No
  repo-wide load failure like the one the 796→797 pair had.

**Docker/DB.** Required, both sides, `pgvector/pgvector:pg16`. Producer: 2 of 3 oracle files
are integration. Consumer: 2 of 6. The integration tests drive a deterministic stub embedder
through `tests/integration/_support/embedder.ts`, which exists at both base commits.

**Verdict: KEEP, narrow the producer oracle. Run third.** Strongest fact of the three on
"easy to get wrong" — four readers scattered across two modules and one lookalike field that
must NOT move — but the most expensive to run and the one that overlaps an existing pair's
subsystem (`tenjin-search-confidence`, same cluster as 746→748).

---

## Ranking

| rank | pair | why |
|---|---|---|
| 1 | `agent-262-273-condense` | Best fact (pipeline order + codegen convention), no Docker, 3 oracle files, fewest flags. **Smoke this first.** |
| 2 | `tenjin-789-798-demand-gates` | Cheapest to run, 291 added lines total, but the most hinted prompt and the weakest reuse gap. |
| 3 | `tenjin-772-841-pooled-gate` | Hardest fact, but needs the producer oracle narrowed, carries a second theme on the consumer, and shares a cluster with the existing 746→748 pair. |

## Rejected while searching

`tenjin-agent #202 → #205` (hooks config rename, +136/7 → +488/16, a genuine
enum-and-alias fact) is **disqualified**: `src/lib/hook-scripts.test.ts` at #205's merge
commit pins literal md5 digests of the generated hook bodies
(`websearch: 'b42da7df23b205ffe6aeb0a8c242353b'` and three more), which no agent-written
implementation can reproduce.

`tenjin-agent #199 → #283` (+402/12 → +403/8, right cluster, right size): the consumer's
tests are about a public by-id fallback and never touch `isSameDeployment`, the producer's
contribution. No shared fact.

`tenjin-agent #261 → #262` and `#253 → #259`: correct direction and sizes, but the
consumer's assertions are about its own new code, not the producer's.

Local-process rules observed: no test run, no server started, no full suite, nothing merged,
no PR or issue opened.
