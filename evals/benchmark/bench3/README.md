# Bench-3 historical reuse experiments

This is the single Bench-3 experiment PR (#355). `protocol.json` defines the
population, deterministic pilot proof queue, four treatments, historical knowledge
cutoffs, delivery analysis and completion metrics. Model admission is still false.
All reusable preparation, containers, databases, task/knowledge assets, scheduling,
verification, reporting and cleanup arrive from Bench-1 through #313.

The frozen frame contains 169 merged PRs from two repositories during August 15
through September 11. Work-type screening proposes 99 runtime candidates and
records 70 coverage gaps. Deterministic ranking selects tenjin#740, tenjin#674,
tenjin-agent#256 and tenjin-agent#170 for proof; their correlation clusters are
excluded from the locked reserve. This is a proof queue, not a completed or
representative model result. Hard tasks cannot be replaced because they cost more
or show less benefit. The pilot calls for 48 consumers and 12 earlier producers.

| Public task                | Contract                                                                                                        | Role                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `repository-replay` (#256) | Repository identity across transports, unknown-origin locality, exact hook cwd and concurrent stale sync claims | Ranked pilot candidate; oracle proof in progress                |
| `release-policy` (#170)    | Latest-only updates, invalid registry answers versus transport errors, daily cache and metadata behavior        | Ranked pilot candidate; original branch boundary being verified |
| `actor-grade` (#247)       | Actor-owned injection transcript evidence                                                                       | Scoped engineering diagnostic; outside the ranked pilot         |
| `actor-score` (#251)       | Actor-owned outcome and search evidence                                                                         | Scoped engineering diagnostic; outside the ranked pilot         |

Private server catalogs/oracles and workload evidence live in the authorized
`tenjin-notes/benchmark/bench3/` directory. The public repository and its CI do not
require that private checkout. #740 covers trending term/question separation;
#674 covers content-based ranking, confidentiality, budgets, limits and telemetry.
Their contracts are kept separate from passing engineering probes.

The catalog pins original PR URLs, before/after commits and trees, dependency locks,
and prepared source content hashes. The same independent oracle runs on both sides.
Prompts name behavior and broad product source roots, without giving the model the
reference patch's file list. Existing tests, fixture support and tooling remain fixed.
Earlier producer tasks and historically versioned lesson bodies must be accepted
before the natural arm is admitted. Stale prior release policy is a declared risk,
not an approved correct answer for the later task.

Prepare each revision from a checkout containing its Git objects:

```sh
python -m evals.benchmark.bench3.replay prepare \
  --repo /path/to/tenjin-agent --task repository-replay --revision before \
  --out /path/to/new/replay-before
python -m evals.benchmark.bench3.replay build --context /path/to/new/replay-before
python -m evals.benchmark.bench3.replay verify \
  --context /path/to/new/replay-before --image sha256:IMAGE_ID \
  --run /path/to/readiness-results
```

Repeat with `--revision after` and a fresh output directory. Preparation reads
committed source only, omits repository automation and installed agent configuration,
and checks independently pinned source bytes. Dependencies install from the frozen
lock with lifecycle scripts disabled. Historical source runs only inside the shared
Bench-1 isolated container with no network or credentials. Private server tasks use
a disposable loopback PostgreSQL/pgvector service in the same isolated namespace.

A readiness pair requires real assertion failure before, every assertion passing
after, and confirmed cleanup. Import, setup, timeout and cleanup errors are invalid
proofs. Readiness checks spend no model tokens and do not establish savings.
The ordinary shared runner will execute the admitted model experiments and report
consumer-reuse metrics plus the complete producer/capture/consumer pipeline cost.
Hook type, actor, shelf, pointer/body form and reviewed applicability stay separate.
Actor-shaped test data does not establish live dispatch-reranker coverage.
