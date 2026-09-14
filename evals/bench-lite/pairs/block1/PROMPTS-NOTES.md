# Block-1 prompts v2 — interface contracts

Rewrite of both prompts for four pairs, SWE-bench style: the ticket now states the observable
interface the PR's own tests assert (exported names and signatures, field names, enum values,
envelope shapes, worked truth tables, which test files and lanes), and nothing about the
implementation or the diff.

Built read-only: `git show` / `git diff` against the local clones, `gh` not needed. No checkout,
no test run, no server, no PR, no issue. Nothing under `wt-bench-lite` was touched.

Method per prompt: diff the oracle test files between the PR's base and merge commit to get
exactly the assertions the PR added, list each assertion's observable requirement, read the
production diff only to phrase it, then write the prompt. Producers are fully specific.
Consumers are fully specific about their OWN interface and silent on the shared fact; each
consumer has a leak-check file with the grep output.

| pair | producer bullets | consumer bullets | leak check |
|---|---|---|---|
| `tenjin-746-748-confidence` | 21 | 15 | 1 hit, benign (`DENSE_COSINE_SIMILARITY_FLOOR`, predates the producer) |
| `tenjin-789-798-demand-gates` | 7 | 11 | 0 hits on the fact; 2 v1 sentences removed |
| `tenjin-772-841-pooled-gate` | 17 | 14 | 0 hits |
| `trending-term-questions` | 27 | 15 | 0 hits on the fact; "four tiers" and `zzq_probe_` removed |

## What the smoke run failed on, and where it is now stated

Agent A's five failures on #746 were all interface mismatch. Each is now a contract bullet in
`prompts/tenjin-746-748-confidence-producer.md`:

- the field is named `confidence` with values `'high' | 'medium' | 'low'` at cuts 0.62 / 0.52,
  both inclusive;
- `corroborated` is a separate boolean, `row.postHit && row.semanticHit === true`;
- neither `score` nor `similarity` may appear as a key on any wire surface;
- the OpenAPI runtime drift guard binds `SearchCandidate.properties` and `required` to what
  `buildSearchResponse` actually returns, on both a fused and an unfused row;
- `fuseLookups` puts a positive fused `score` on every row and copies `similarity` only where the
  dense leg placed it, read back off the `dense` array.

## Unfair assertions that survive a contract, per test file

"Unfair" here means an assertion an agent cannot satisfy from the stated contract plus the
repository: a private identifier it must guess, an exact prose string, a digest of generated
output, or a white-box pin on statement order.

### tenjin-746-748-confidence

| file | finding | recommendation |
|---|---|---|
| producer `lib/lookup.test.ts` | clean; `denseRow` is defined inside the oracle file itself | keep |
| producer `lib/search-response.test.ts` | clean; every assertion is wire-observable | keep |
| producer `lib/openapi.test.ts` | drift guard is stated in full | keep |
| producer `tests/integration/search-route-envelopes.test.ts` | the deny-list and its two exceptions live in the test; stated | keep |
| consumer `tests/integration/answer.test.ts` | imports `CONFIDENCE_MEDIUM_SIMILARITY` by name from `@/lib/search/project`, a constant the producer made module-private. The consumer prompt cannot name it without leaking, so the identifier reaches the agent only as an import error | **keep**. Dropping this file removes the consumer's entire oracle. The prompt tells the agent that one unnamed module-private constant in that module must be widened to `export` |
| consumer `tests/integration/lookup-hybrid.test.ts` | at this commit it only moves the stub embedder into `_support/embedder.ts`, which the oracle copies | keep |

### tenjin-789-798-demand-gates

| file | finding | recommendation |
|---|---|---|
| producer `tests/integration/search-telemetry.test.ts` | pins the exact historical code-veto strings `'a question'` and `'What is the latest on Found 3 article(s).?'`; both are now in the contract | keep |
| consumer `lib/search/gates.test.ts` | clean | keep |
| consumer `tests/integration/search-telemetry.test.ts` | the SQL/TS parity case is locale-dependent: `[[:alpha:]]` and `length()` were verified under the suite's `C.UTF-8`. A container whose collation differs changes the answer (the known pgvector-collation trap) | keep, and pin the image; the constraint paragraph names the locale |

### tenjin-772-841-pooled-gate

| file | finding | recommendation |
|---|---|---|
| producer `scripts/eval/lookup-gold-set.ts` | **SEVERE.** #772 is the PR that adds the `junk` register with its eight prompts. The gold set IS a third of the task's spec | **drop**, with the file below |
| producer `scripts/eval-lookup-recall.test.ts` | imports `REGISTERS` from the file above | **drop**; use `command_narrowed` |
| producer `tests/integration/search-floor.test.ts` | thresholds are derived from the constants, not pinned | keep |
| producer `tests/integration/lookup-hybrid.test.ts` | clean | keep |
| consumer `lib/search/project.test.ts` | pins the prose strings `'identifier/title/excerpt lexical match'` and `'semantic match'`; both predate this PR and are stated in the contract | keep |
| consumer `lib/search-response.test.ts` | clean once `pooledSimilarity` / `chunkCount` are stated | keep |
| consumer `lib/search/retrieve/lexical-rank.test.ts` | **white-box.** Asserts the rendered SQL TEXT of `statements()[2]` contains `count(*)`, `creators`, `deleted_at`, `status` — it pins statement ORDER and the fact that the predicate is built from drizzle column references rather than a literal string | keep ONLY if the BM25 theme stays; the contract now states the statement index and the four substrings. Drop it with `command_narrowed` |
| consumer `tests/integration/search-keyword-leg.test.ts` | behavioural (`bm25CorpusSize` returns 2); second theme, independent of the shared fact | drop with `command_narrowed`, else keep |
| consumer `scripts/eval-lookup-recall.test.ts` | forces the offline script's ranked-row shape to gain `best` beside `similarity`; low value, stated | drop with `command_narrowed`, else keep |
| consumer `tests/integration/lookup-hybrid.test.ts` | `seedChunked` asserts `contentChunks` emits exactly one chunk per 500-char section, so a retune of the chunker's min/target constants breaks the fixture rather than the product | keep, flagged as environmental |

### trending-term-questions

| file | finding | recommendation |
|---|---|---|
| producer `oracles/demand-honesty.test.ts` | pins three exact prose strings: the `<h2>` text `Answered and bought`, the landing literal `asked by 2`, and the negative `Each answer now earns on every read`. All three are now stated verbatim in the contract | keep |
| producer `oracles/demand-honesty.test.ts` | pins the page's pulse SENTENCE SHAPE through `/\b8(?:\s+\w+){0,2}\s+search/i` and two siblings: a truthful sentence that puts more than two words between the number and its noun fails | keep, flagged. The three regexes are quoted in the contract |
| producer `oracles/demand-honesty.test.ts` | `existsSync('lib/payments/answer-example.ts')` pins an exact new file path; stated | keep |
| producer `oracles/demand-honesty.test.ts` | renders real React components through jsdom with a hand-rolled global stub set, and drives a dialog through `act`. Heaviest environmental surface of the four pairs | keep, flagged |
| consumer `oracles/trending-term-questions.test.ts` | parameterises over the four public tier names as string literals, disclosing the producer's `getConvertedQuestions` at run time | keep; unavoidable, since the consumer's contract is "apply this to all of them" |
| consumer `oracles/trending-term-questions.test.ts` | no prose strings, no digests, no private helpers; every number falls out of the fixtures | keep |

Nothing in any of the eight oracles pins an md5 of generated output. That failure mode was
already screened out when `tenjin-agent #202 → #205` was rejected.

## Two things the harness must decide

1. **`tenjin-772-841-pooled-gate` producer oracle.** Use `command_narrowed` and drop the two
   `scripts/eval*` entries from the copy list. The v2 producer prompt states no eval contract, so
   running the wide command would fail the agent on a spec it was never given.
2. **`tenjin-772-841-pooled-gate` consumer oracle.** The BM25 corpus-count theme is independent
   of the shared fact. If you run `command_narrowed`, cut the "Second, unrelated change in the
   same area" section and the last three test files from the consumer prompt's constraint
   paragraph; they are written as one contiguous block for exactly that reason.
