# Bench-2 local-reuse experiments

Bench-2 selects tasks, treatments, producer/consumer protocol, repeats and caps from the shared
Bench-1 framework. It adds no runtime, reporting engine, or replacement fixture library.
`benchmark-canary.yml` and `benchmark-headline.yml` call Bench-1's reusable `benchmark-shelf.yml`.
The `benchmark-live.yml` dispatch bridge selects the canary on demand before its own workflow
is registered on main.

Use the same `images build` and `cli live-run --manifest PATH` commands locally and in CI.
Docker Compose runs against Docker or Colima locally. Bench-1 handles execution, verification,
phase accounting, reports, artifacts, main regression comparisons and cleanup. Historical
results remain in `tenjin-notes/benchmark/`; no provisional number here is hardened.

## What runs

Claude selections use Opus 5; matched Codex selections use CLI 0.154.0 / `gpt-5.6-sol`,
low reasoning and requested fast service. Both use subscription allowance only. Claude core
admits up to three workers, with only one shelf-provisioning trial at a time. Codex serializes
its managed auth file; preflight/canary/recursive are also serial. Producer sessions are additional model work. The smoke configurations live in Bench-1: plumbing is one control launch, hooks smoke is
4 consumers, and failure-key smoke is 6 consumers. They check different delivery paths.

| Experiment              | Tasks × arms × repeats | Consumers | Producers | Purpose / trigger                                                                                                                                             |
| ----------------------- | ---------------------- | --------: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Natural-reuse preflight | 3 × 2 × 1              |         6 |         3 | Manual capture/reuse check: actor, alias and core cover convention, path-alias and workspace setup.                                                           |
| Full core               | 10 × 5 × 3             |       150 |        30 | Main comparison: off, flat notes, seeded, seeded without public fallback, natural. Weekly/release/manual; ready PRs require only `benchmark: headline`.       |
| Seeded canary           | 2 × 2 × 1              |         4 |         0 | Alias/workspace health check. Ready PRs use `benchmark: canary`; adding it and subsequent pushes run the canary. Main pushes/nightly/manual supply baselines. |
| Recursive diagnostic    | 1 × 4 × 3              |        12 |         3 | Delegated diagnosis and capture/delivery check, also run after full core with a separate report.                                                              |

The canary has no path filter: every ready PR into main with `benchmark: canary` gets the same
four attempts, including changes outside the benchmark directory. The same label opts into
the live plumbing smoke. Ordinary CI, including offline benchmark checks, stays automatic.
Full Bench-2 requires only `benchmark: headline`; neither `ci` nor `benchmark: canary` is a
prerequisite. Unrelated label events start neither lane. Main baseline triggers stay automatic.
Forks without credentials report a skip rather than a measured pass.

Preflight and canary use 600-second consumer caps; core uses 1,500 seconds. Their results do not
pool. One-repeat health checks cannot establish a reliable speedup or replace the full core run.
A configured experiment is not a completed result: read verified versus planned attempts,
invalid/capped outcomes, and time/tokens to verified completion before interpreting comparisons.

## Harness releases

Fresh CI experiments and local runs using `harness_release` track the official `latest` CLI
release. Resolution happens once before image builds, attestation or corpus reset. All arms
and producer/consumer phases use the same saved `harness-lock.json`; checkpoint resumes keep
its version and integrity without querying the registry. Reference manifests retain exact
pins for offline tests and reproduction, but those are not the live resolver's default.

```sh
python3 -m evals.benchmark.harness_release --manifest evals/benchmark/fixtures/live/codex-core-selection.json --out harness-lock.json
python3 -m evals.benchmark.images build --manifest harness-lock.json
```

Use the lock for subsequent `describe`, `attest`, `live-run`, and checkpoint commands. Add
`--version X.Y.Z` to the resolver to reproduce an exact release. This updates the harness,
not the selected Opus 5/Sol models, subscription-only authentication or speed settings.

The readout records the resolved package, version, integrity and timestamp. PR product
comparisons require the exact same release; a separate harness-update diagnostic compares
with the latest otherwise-compatible main run and shows both versions, product commits and
server deployments. A mixed product/server change cannot be attributed to the harness.
No extra old-version baseline is automatically run. Missing or invalid evidence stays explicit.

## Targeted selections of core

The copied full-corpus and high-discovery manifests are removed. Two small selection files
inherit the core definitions and pins, so the same treatments cannot drift between diagnostics:

- `fixtures/live/corpus-selection.json`: all ten tasks, off/seeded, three repeats (60 consumers).
- `fixtures/live/high-discovery-selection.json`: shadow/ambient, off/seeded, three repeats (12 consumers).

These are optional targeted reruns, not additional scheduled experiments or independent headline
replications. Their task and arm rows already exist in a completed core report. To inspect or run
a selection, pass its path to the same commands, for example:

```sh
python -m evals.benchmark.cli describe --manifest evals/benchmark/fixtures/live/high-discovery-selection.json
```

No fixture, lesson, verifier, full-core treatment or recursive experiment was removed. Historical
notes and exports are unchanged. Bench-3 adds representative team experiments on this framework.

## Runtime and remaining limits

The canary caps four consumers at 600 seconds each: at most 40 consumer minutes before setup
and verification, with a 60-minute job timeout. This is a ceiling, not an expected duration.
Its small sample flags possible regressions; it cannot establish a statistically reliable speedup.

The reduced preflight is 9 model sessions instead of 72. On September 11, the matched Sol
preflight passed 6/6 consumers and 3/3 producers with native usage reconciliation in **489.5
seconds end to end**. Its consumer agent execution totaled 237.0 seconds; producer work and
orchestration are separate. Natural capture sometimes produced no finding, so this establishes
execution/accounting, not a reuse benefit.

Full core remains 180 model sessions. Preliminary chunks suggest roughly three hours,
subject to harder tasks and subscription limits; this is not a completed full-run measurement.
The old fixture configuration paused at 40/150 passing consumers. The corrected September 12
run stopped cleanly at 30/150 passing consumers and six passing producers after the remote
server deployed a new revision during the schedule. No owned containers remain from either
run. The benchmark parent also lacks the newer reranker schema fields present in its upstream
team-shelf database. A fresh full run awaits schema alignment and a stable server window. The first
recursive probe exposed contradictory fixture instructions and copied native fork metadata.
Those probes are diagnostic evidence only: the corrected actor fixture has a new hash and
experiment versions, so fresh measurements cannot pool with their old results. Recursive
producers and consumers now require a positive-usage native descendant to count as a pass.
The corrected Sol recursive diagnostic on `f00c91a5` completed **12/12 consumers and 3/3
producers**, all with two native actors and matched usage, in **24.2 minutes of active run
time** including setup/cleanup and excluding operator pauses. The three natural producers retained three capture drafts, but zero reusable closed failure
pairings; none of their consumers received an injection. The producer-to-consumer database
transfer was intact. The current Codex adapter never establishes successful-shell evidence to
close those pairings, and capture drafts are not a searchable shelf. Publication in those recorded runs was protocol-confounded: producer instructions banned
network access while the Stop nudge requested publishing, and the traces contain no publish attempt. These observations do not
establish a Codex 0.154.0 native hook limitation or isolate product quality. Seeded failure-hook
delivery reached children. This one-fixture result establishes execution/accounting coverage, not a natural-reuse
benefit or team-representative result. Codex does not expose the dispatch work order through
its current product adapter, and its discovery counters remain unavailable until native parsing
is implemented. Claude dispatch-reranker acceptance is still separate.

The current natural arm explicitly selects **host-assisted publication**. A verified producer
responds to the product's capture ask with its own finding fence; the host publishes those
captured drafts free on the disposable shelf before the consumer starts. It adds no lesson,
fingerprint key or nonce prose. An empty capture stays empty. Task containers carry no wallet
and allow only configured Tenjin read commands over the network. The readout separates drafts,
closed local pairings, published pieces, exact producer-piece team-hook deliveries, verified
consumers after delivery, publication failures and cleanup. Host publication time is separate
from agent completion time; delivery plus a pass does not establish that knowledge helped.
This intervention measures assisted publication, not autonomous publishing. The `host1`
experiment versions require new measurements; old diagnostic records are not pooled.

Full core still has 150 consumers and 30 producers; recursive stays 12 plus three. At the latest
partial core's pace, combined runtime is provisionally **3–4 hours**, before added publication
overhead. Natural trials now avoid one redundant dependency export each (30 core plus three
recursive); the measured saving is not yet known. Codex managed-auth runs remain serial,
Claude independent work may fill three workers, and shared-shelf trials remain exclusive through
publication, consumption and cleanup. No model calls were spent validating this protocol change.
A fresh full run still waits for benchmark schema alignment through tenjin#846.

The earlier eight-hour planning allowance is superseded by these preliminary measurements.
GitHub-hosted jobs stop at six hours. The shared runner now subtracts elapsed setup and reserves
active-trial/cleanup/upload time, then stops admission and saves an incomplete checkpoint.

Bench-1 owns frozen-LSN continuation and per-reset receipts. Two live resets confirmed the
same source revision with distinct verified epoch receipts. The shared CLI can run bounded
chunks with `--freeze-corpus --max-new-trials 10 --until-complete`; optional
`--admission-seconds` stops new trials while active ones finish. Full coverage, not a chunk,
is the experiment. Portable checkpoint import requires the same tested commit, runtime,
manifest and full schedule. See the shared README for export/import commands.

Manual headline dispatch accepts explicit core and recursive checkpoint run/artifact pairs.
When recovering only recursive work, also provide its prior completed core checkpoint so core
finishes without new model calls. A changed tested commit must start a fresh run. Checkpoint
files carry normalized records and corpus proof, never credentials or transcripts.

Matched Codex files are `codex-preflight-selection.json`, `codex-core-selection.json` and
`codex-recursive-selection.json`. Each reuses the corresponding Claude experiment's tasks and
treatments with complete Codex pins. Keep their reports separate from Claude. The reusable CI
workflow currently has Claude credentials; Codex selections are operator-run until a managed
subscription credential is configured for CI.

## Remote server preparation

Bench-1 automatically records the remote Next.js deployment ID and checks it after completed
trials and before continuations. A changed or unavailable ID stops admission and qualifies the
readout as diagnostic-only. This is observation, not a deployment lock or schema audit. Database
preparation must update the parent used for resets, then a fresh run freezes that revision;
migrating only the disposable child is lost at reset. A frozen LSN does not pin the remote
server code. Record the server commit/deployment with the run and qualify or restart a
comparison that spans a server change.

On September 12, GitHub recorded a production tenjin-bench deployment of tenjin commit
`98b5bc34` (reranker #844) at 12:35 UTC, after the first corrected core run had started. That
run is retained as diagnostic evidence and will not pool with a future run against the
updated server. Main pushes can deploy each connected Vercel project; manually redeploying
public tenjin alone is a separate operation.

A separately requested tenjin migration-workflow PR adds the benchmark parent and disposable
database to the existing migration targets. It covers both local and CI benchmark runs; its
secrets and applied migrations must be verified before the next full measurement.
