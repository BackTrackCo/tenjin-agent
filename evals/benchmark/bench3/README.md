# Bench-3 historical reuse experiments

This is the single Bench-3 experiment PR (#355). `protocol.json` defines the
population, deterministic pilot proof queue, four treatments, historical knowledge
cutoffs, delivery analysis and completion metrics. The pilot is readmitted under a fresh oracle-v2 freeze; earlier engineering cohorts remain separate.
All reusable preparation, containers, databases, task/knowledge assets, scheduling,
verification, reporting and cleanup arrive from Bench-1 through #313.

The frozen frame contains 169 merged PRs from two repositories during August 15
through September 11. Work-type screening proposes 99 runtime candidates and
records 70 coverage gaps. Deterministic ranking selects tenjin#740, tenjin#674,
tenjin-agent#256 and tenjin-agent#170 for proof; their correlation clusters are
excluded from the locked reserve. This is a proof queue, not a completed or
representative model result. Hard tasks cannot be replaced because they cost more
or show less benefit. The pilot calls for 48 consumers and 12 earlier producers.

| Public task                | Contract                                                                                             | Role and verified checks                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `repository-replay` (#256) | Repository identity across transports, unknown-origin locality, exact hook cwd and stale sync claims | Pilot consumer; 9 checks                 |
| `release-policy` (#170)    | Latest-only releases, registry versus transport errors, daily cache and metadata                     | Pilot consumer; 14 checks                |
| `update-command` (#136)    | Manager ownership, explicit update, bounded output and passive notices                               | Earlier producer for #170; 24 checks     |
| `team-learning` (#243)     | Publication, independent verification, local fallback and repository-scoped replay                   | Earlier producer for #256; 26 checks     |
| `actor-grade` (#247)       | Actor-owned injection transcript evidence                                                            | Engineering diagnostic outside the pilot |
| `actor-score` (#251)       | Actor-owned outcome and search evidence                                                              | Engineering diagnostic outside the pilot |

Private server catalogs/oracles and workload evidence live in the authorized
`tenjin-notes/benchmark/bench3/` directory. The public repository and its CI do not
require that private checkout. #740 covers trending term/question separation;
#674 covers content-based ranking, confidentiality, budgets, limits and telemetry.
Their earlier producers are #727 demand population honesty and #670 content-vector generation. The four private tasks have 10, 27, 16 and 19 checks respectively. All eight before/after proof pairs pass admission: the before has assertion failures, the after passes all checks, and cleanup is confirmed. These 145 checks are verifier evidence, not model outcomes.

The catalog pins original PR URLs, before/after commits and trees, dependency locks,
and prepared source content hashes. The same independent oracle runs on both sides.
Prompts name behavior and broad product source roots, without giving the model the
reference patch's file list. They are retrospectively reconstructed work orders, not
recovered original user prompts. Requirements inferred from final historical source
are disclosed; all four producer tasks declare callable interfaces for independent
testing. This evaluates implementation under those interfaces, not unconstrained
architecture selection. Existing tests, fixture support and tooling remain fixed.
The earlier producer tasks and four historically versioned lesson bodies have been
reviewed. The model-visible environment passed 33 isolated source/adapter checks. Bound
manifests pass all 16 distinct task/arm dry-run templates, including four producers.
The pilot freezes 600 seconds per phase, Sol/low/requested-fast subscription mode,
and serialized mutable-shelf execution. All eight immutable consumer/producer images are built and their identities verified.
The pilot is diagnostic; it cannot establish a representative team effect. Stale prior release policy is a declared risk,
not an approved correct answer for the later task.

The latest engineering checkpoint separates generated-build rejection from behavior.
After the shared Bench-1 repair, eight reference patches pass all 145 checks with
build/cache/report outputs present. Retained repository-replay model patches still
fail: control passes 6/9 checks, flat and seeded 7/9. The original records and costs
remain in notes and are not pooled into a future controller cohort. The demand-honesty UI oracle now accepts equivalent copy and the real agents setup
page. Reference and equivalent UI pass 16/16 checks; the retained producer still
fails six data requirements (10/16 pass). Five targeted UI defects are caught.
This adjudication used no model calls and changed no task, prompt, treatment or
source fixture. The fresh cohort binds the corrected oracle before admission;
notes retain both oracle identities, the proof and the earlier original attempts.

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
lock with lifecycle scripts disabled. Readiness verification runs historical source inside the shared
Bench-1 isolated container with no network or credentials. Private server tasks use
a disposable loopback PostgreSQL/pgvector service in the same isolated namespace.

Live model tools use the shared provider/shelf allowlist and subscription credentials,
with a separate disposable database and visible source-test adapter for server tasks.
They cannot access the hidden oracle. Their environment is reported separately from
credential-free verification.

A readiness pair requires real assertion failure before, every assertion passing
after, and confirmed cleanup. Import, setup, timeout and cleanup errors are invalid
proofs. Readiness checks spend no model tokens and do not establish savings.
Once readmitted under a new freeze, the ordinary shared runner executes the model experiments and reports
consumer-reuse metrics plus the complete producer/capture/consumer pipeline cost.
Hook type, actor, shelf, pointer/body form and reviewed applicability stay separate.
Actor-shaped test data does not establish live dispatch-reranker coverage.
