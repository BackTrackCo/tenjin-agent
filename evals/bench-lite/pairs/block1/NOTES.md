# block1 — four producer/consumer pairs

Assembled from two scratchpad task packages. Paths in `pairs.json` are relative to this
directory, which is what `run.py` expects.

| pair                        | repo         | producer PR | consumer PR | needs                          |
| --------------------------- | ------------ | ----------- | ----------- | ------------------------------ |
| `tenjin-746-748-confidence` | tenjin       | 746         | 748         | Docker (testcontainers)        |
| `agent-219-266-state-store` | tenjin-agent | 219         | 266         | Node >= 24 only                |
| `content-retrieval`         | tenjin       | 670         | 674         | Postgres + pgvector, fixed URL |
| `trending-term-questions`   | tenjin       | 727         | 740         | Postgres + pgvector, fixed URL |

Run `tenjin-746-748-confidence` first. Its source notes call it the strongest pair: both PRs are
single-theme and small, the shared fact is an enum plus two numeric cuts, and the consumer's
`qualify` gate is literally unwritable without it.

## Three different database stories

**`content-retrieval` and `trending-term-questions` — the bench3 hidden-oracle path.**
Their oracle imports `startDatabase` from `#benchmark/database`. That alias is resolved by the
staged `.bench3/vitest.config.mjs`, and `startDatabase()` does three things, in order:

1. Hard-fails unless `BENCHMARK_DATABASE_URL` is **exactly**
   `postgresql://postgres@127.0.0.1:5432/benchmark`. Not an equivalent URL — a string compare.
2. `CREATE EXTENSION IF NOT EXISTS vector`.
3. Applies `drizzle/migrations` **from the checkout at the base commit**, through drizzle-orm's
   own migrator.

So the oracle migrates the database itself. Do not run the repo's migrate script first, and do
not reuse a database another pair already migrated: the two base commits carry different
migration sets (44 SQL files at `content-retrieval`'s consumer base, 46 at
`trending-term-questions`'s), so a database left over from one pair is the wrong schema for the
other. **Start a fresh container per session.**

Bring it up, publishing the port so the fixed URL resolves from the host:

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
default collation, and text ordering assertions move with it. The real harness pins the image by
digest and shares a network namespace with the task container; `-p 127.0.0.1:5432:5432` is the
local equivalent. Stop the container when the run is done — bench-lite will not stop it for you,
and leaving it up violates the no-servers rule.

**`tenjin-746-748-confidence` — testcontainers.** The PR's own integration tests boot
`pgvector/pgvector:pg16` through `@testcontainers/postgresql`. No fixed URL and no manual
container: just a running Docker daemon. Both of the consumer's oracle files are integration
tests, so Docker is mandatory for the consumer; the producer needs it for one of four files.

**`agent-219-266-state-store` — none.** Embedded SQLite via `node:sqlite`.

## Node

`node --version` on this machine is **v24.19.0**, which satisfies the requirement. PR 219 raises
`engines.node` from `>=22` to `>=24`; the base commit still declares `>=22`, so the engines field
will not protect you. On Node 22 `node:sqlite` behaves differently and the store's fail-open path
swallows it silently, which reads as a mysterious oracle failure rather than a version problem.

## Two local adaptations, both deliberate

1. `oracles/vitest.config.mjs` is the harness file with two lines changed, documented in its own
   header. The `#benchmark/database` alias pointed at the container-absolute
   `/benchmark-database.mjs`; it now resolves under the checkout, and `pairs.json` stages
   `database.mjs` at `.bench3/benchmark-database.mjs`. `cacheDir` moved off the shared
   `/tmp/benchmark-historical-vite-cache` to a per-checkout path. `test.include` is untouched and
   still hardcoded to the single hidden-oracle file.
2. `run.py` now refuses any `oracle.copy` destination that is absolute or contains `..`, at load
   time and again at copy time. Writing to the filesystem root is not something a benchmark
   should be able to do by accident.

## Prescriptiveness flags, carried over

These are reasons a pass or a failure may not mean what it looks like.

**`agent-219-266-state-store`.** Moderate. The consumer oracle pins the state-key prefix
`capture:activity:` and the three kind names `inspection`, `mutation`, `shell` verbatim, which
are implementation-private choices the prompt describes only in prose. One test also asserts the
exact wording of the Stop capture brief, and prose assertions are unreachable without the PR's
own copy. The producer oracle here is **trimmed to 5 files** on the source notes'
recommendation; `src/sidecar-e2e.test.ts`, `src/commands/outcome.test.ts`,
`src/commands/publish.test.ts` and `src/commands/uninstall.test.ts` were dropped as incidental to
the state store.

**`tenjin-746-748-confidence`.** Moderate. The consumer oracle imports
`CONFIDENCE_MEDIUM_SIMILARITY` by name from `@/lib/search/project`, so running it reveals the
constant's identifier and module. It does not reveal the value 0.52, the high cut 0.62, the enum
values, or that the bucket reads the dense leg alone. The consumer oracle also stages
`tests/integration/_support/embedder.ts`, which is pure test infrastructure and leaks nothing.

**Both bench3 pairs.** The pair is named for the **consumer** task, and the producer is a
different task whose own hidden oracle is a differently named file: `content-retrieval`'s
producer (PR 670) is graded by `content-generation.test.ts`, and `trending-term-questions`'s
producer (PR 727) by `demand-honesty.test.ts`. That asymmetry is inherited from the source
package and is worth confirming before a real run, because it is exactly what a copy-paste slip
would also look like.

**All four pairs.** Every consumer's base commit already contains the producer's merged code, so
the shared fact is never genuinely _unavailable_ to agent B — it is discoverable by reading B's
own tree. These pairs measure **search cost saved**, not information transfer. Still a real reuse
signal, but do not describe the result as "B could not have known this".

## Consumer prompts

`content-retrieval` and `trending-term-questions` use the `*-consumer.trimmed.md` prompts, with
the reconstructed-compatibility block removed. The filename keeps the `.trimmed` marker so the
provenance stays visible against the source package. The other two pairs use their verbatim
consumer prompts.
