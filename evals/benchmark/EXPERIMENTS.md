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

| Experiment              | Tasks × arms × repeats | Consumers | Producers | Purpose / trigger                                                                                                                                            |
| ----------------------- | ---------------------- | --------: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Natural-reuse preflight | 3 × 2 × 1              |         6 |         3 | Manual capture/reuse check: actor, alias and core cover convention, path-alias and workspace setup.                                                          |
| Full core               | 10 × 5 × 3             |       150 |        30 | Main comparison: off, flat notes, seeded, seeded without public fallback, natural. Weekly/release/manual; ready PRs require `ci` plus `benchmark: headline`. |
| Seeded canary           | 2 × 2 × 1              |         4 |         0 | Alias/workspace health check. Ready PRs use `ci`; adding it and subsequent pushes run the canary. Main pushes/nightly/manual supply baselines.               |
| Recursive diagnostic    | 1 × 4 × 3              |        12 |         3 | Delegated diagnosis and capture/delivery check, also run after full core with a separate report.                                                             |

The canary has no path filter: every ready PR into main with `ci` gets the same four attempts,
including changes outside the benchmark directory. #349 introduces the matching normal-CI
label gate and is not yet merged; until it lands, normal tests retain their existing trigger.
The full experiment requires both PR labels; unrelated label events start neither lane.
Forks without credentials report a skip rather than a measured pass.

Preflight and canary use 600-second consumer caps; core uses 1,500 seconds. Their results do not
pool. One-repeat health checks cannot establish a reliable speedup or replace the full core run.
A configured experiment is not a completed result: read verified versus planned attempts,
invalid/capped outcomes, and time/tokens to verified completion before interpreting comparisons.

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

Full core remains 180 model sessions. Its first frozen ten-consumer chunk passed in 723.1
seconds including producer and orchestration work. That early pace suggests roughly three
hours, subject to harder tasks and subscription limits; it is not a validated full-run forecast.
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
