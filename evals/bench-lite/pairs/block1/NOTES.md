# block1 — four producer/consumer pairs

Assembled from three scratchpad task packages. Paths in `pairs.json` are relative to this
directory, which is what `run.py` expects.

| #   | pair                          | repo   | producer PR | consumer PR | needs                          |
| --- | ----------------------------- | ------ | ----------- | ----------- | ------------------------------ |
| 1   | `tenjin-746-748-confidence`   | tenjin | 746         | 748         | Docker (testcontainers)        |
| 2   | `tenjin-789-798-demand-gates` | tenjin | 789         | 798         | Docker (testcontainers)        |
| 3   | `trending-term-questions`     | tenjin | 727         | 740         | Postgres + pgvector, fixed URL |
| 4   | `tenjin-772-841-pooled-gate`  | tenjin | 772         | 841         | Docker (testcontainers)        |

`pairs.json` holds exactly these four, in this order.

**Not in `pairs.json`, files still present:** `agent-219-266-state-store` and
`content-retrieval`. Their prompts and oracles are left in `prompts/` and `oracles/` so a pair
can be put back by restoring its entry, and they are harmless where they sit.

**Parked:** `agent-262-273-condense` lives in `../parked/` for reference, with the source
package's own notes as `../parked/NOTES-source.md`. Its source notes rank it the best fact of
its set (a pipeline order plus a code-generation convention, no Docker), so it is the first
candidate if a slot opens.

## Base-state verification

Every pair's oracle was run once at its base commit in a throwaway worktree with **no agent**,
to prove it fails for the reason the task is about rather than for a runner or environment
reason. All worktrees were removed afterwards.

| pair / side                          | result at base                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenjin-789-798` producer            | 1 failure: `expected { total: 6, matched: 3, missed: 3 } to deeply equal { total: 4, matched: 3, missed: 1 }` — the veto gate PR 789 adds is not there, so synthetic rows are not dropped |
| `tenjin-789-798` consumer            | 4 failures, led by `TypeError: publishableQuestionShape is not a function` (the SQL twin the consumer must write) and the `'😀a'` non-BMP code-point assertion                            |
| `tenjin-772-841` producer (narrowed) | 8 failures, all `expected 1 to be +0` style assertions on `matched` — the pooled gate does not exist yet                                                                                  |
| `tenjin-772-841` consumer            | 9 failures across `project.test.ts`, `search-response.test.ts` and `lexical-rank.test.ts`                                                                                                 |

No corepack crash, no module-resolution error, no container failure in any of the four.
Testcontainers pulled and ran `pgvector/pgvector:pg16` each time. Each check took 54-66 seconds
including `pnpm install`.

## Three different database stories

**`trending-term-questions` — the bench3 hidden-oracle path.** Its oracle imports
`startDatabase` from `#benchmark/database`. That alias is resolved by the staged
`.bench3/vitest.config.mjs`, and `startDatabase()` does three things, in order:

1. Hard-fails unless `BENCHMARK_DATABASE_URL` is **exactly**
   `postgresql://postgres@127.0.0.1:5432/benchmark`. Not an equivalent URL — a string compare.
2. `CREATE EXTENSION IF NOT EXISTS vector`.
3. Applies `drizzle/migrations` **from the checkout at the base commit**, through drizzle-orm's
   own migrator.

So the oracle migrates the database itself. Do not run the repo's migrate script first, and do
not reuse a database another pair already migrated — base commits carry different migration
sets. **Start a fresh container per session**, publishing the port so the fixed URL resolves
from the host:

```bash
docker run --rm -d --name bench-lite-postgres \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=benchmark \
  -e POSTGRES_INITDB_ARGS=--locale=C.UTF-8 \
  pgvector/pgvector:pg17
```

`POSTGRES_HOST_AUTH_METHOD=trust` is required because the URL carries no password.
`POSTGRES_INITDB_ARGS=--locale=C.UTF-8` is not decoration: changing the pgvector image flips the
default collation, and text ordering assertions move with it. Stop the container when the run is
done — bench-lite will not stop it for you, and leaving it up violates the no-servers rule.

**`tenjin-746-748`, `tenjin-789-798`, `tenjin-772-841` — testcontainers.** Each PR's own
integration tests boot `pgvector/pgvector:pg16` through `@testcontainers/postgresql`. No fixed
URL and no manual container, just a running Docker daemon. The collation point applies here too:
789's producer verified Postgres `[[:alpha:]]` and `length()` against TypeScript `\p{L}`
semantics under the suite's `C.UTF-8` locale, so a different collation changes the answer.

**Running two of these at once is the known stall.** Three of the four pairs drive
testcontainers, and concurrent suites contend for Docker. Keep `--workers 1` unless you have
measured otherwise.

## Node

`node --version` on this machine is **v24.19.0**. The three tenjin pairs declare `>=22`; the
runner pins the node it resolved onto `PATH` for the agent, `pnpm install` and the oracle alike,
and records `node --version` per session.

## Two local adaptations, both deliberate

1. `oracles/vitest.config.mjs` is the harness file with two lines changed, documented in its own
   header. The `#benchmark/database` alias pointed at the container-absolute
   `/benchmark-database.mjs`; it now resolves under the checkout, and `pairs.json` stages
   `database.mjs` at `.bench3/benchmark-database.mjs`. `cacheDir` moved off the shared
   `/tmp/benchmark-historical-vite-cache` to a per-checkout path. `test.include` is untouched.
2. `run.py` refuses any `oracle.copy` destination that is absolute or contains `..`, at load
   time and again at copy time.

## Prescriptiveness flags, carried over

Reasons a pass or a failure may not mean what it looks like.

**`tenjin-746-748-confidence`.** Moderate. The consumer oracle imports
`CONFIDENCE_MEDIUM_SIMILARITY` by name from `@/lib/search/project`, revealing the constant's
identifier and module. It does not reveal the value 0.52, the high cut 0.62, the enum values, or
that the bucket reads the dense leg alone.

**`tenjin-789-798-demand-gates`.** Moderate, and this is the weakest pair on the axis the
benchmark measures. Its consumer prompt carries two deliberate hints the others do not: it tells
the agent to look at the existing veto's shape, and it names the length disagreement in the
abstract. Without the second hint the code-point case is close to unpassable; with it, the gap a
shelf note would close is narrower. Also mild: the producer is 95 added lines over 2 files, so
do not describe it as mid-sized, and the consumer oracle imports `publishableQuestionShape`,
fixing that identifier and module.

**`trending-term-questions`.** The pair is named for the **consumer** task (PR 740); the
producer is PR 727, whose own hidden oracle is the differently named `demand-honesty.test.ts`.
That asymmetry is inherited from the source package and is worth confirming before a real run,
because it is exactly what a copy-paste slip would also look like.

**`tenjin-772-841-pooled-gate`.** The producer oracle is **narrowed**, per its source notes:
`scripts/eval-lookup-recall.test.ts` and `scripts/eval/lookup-gold-set.ts` are dropped from both
the copy set and the command, together, because the `junk` register that PR 772 adds to the gold
set is roughly a third of the producer's spec. Staging it would hand the agent the answer.

The consumer keeps its **full** command, which is what was asked for, but note that two of its
six files (`lib/search/retrieve/lexical-rank.test.ts` and
`tests/integration/search-keyword-leg.test.ts`) belong to the PR's second, independent theme,
the BM25 corpus count, about which the shared fact says nothing. The base-state check confirmed
this concretely: one of the nine failures is `lexical-rank.test.ts` asserting that a count query
mentions `creators`, which has nothing to do with the pooled gate. `oracle.command_narrowed` in
the source package drops both files; if the consumer is ever narrowed too, the matching cut is
the last paragraph of its prompt. Also moderate: the oracle spells `pooledSimilarity` and
`chunkCount`, fixing both identifiers, and this pair shares a subsystem with
`tenjin-746-748-confidence`.

**All four pairs.** Every consumer's base commit already contains the producer's merged code, so
the shared fact is never genuinely _unavailable_ to agent B — it is discoverable by reading B's
own tree. These pairs measure **search cost saved**, not information transfer. Do not describe a
result as "B could not have known this".

## Consumer prompts

`trending-term-questions` uses the `*-consumer.trimmed.md` prompt, with the
reconstructed-compatibility block removed; the filename keeps the `.trimmed` marker so the
provenance stays visible against the source package. The three tenjin PR pairs use their
verbatim consumer prompts.
