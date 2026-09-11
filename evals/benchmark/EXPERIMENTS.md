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

All selections use Claude Code with one trial at a time. Producer sessions are additional model
work. The smoke configurations live in Bench-1: plumbing is one control launch, hooks smoke is
4 consumers, and failure-key smoke is 6 consumers. They check different delivery paths.

| Experiment              | Tasks × arms × repeats | Consumers | Producers | Purpose / trigger                                                                                                                                            |
| ----------------------- | ---------------------- | --------: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Natural-reuse preflight | 3 × 2 × 1              |         6 |         3 | Manual capture/reuse check: actor, alias and core cover convention, path-alias and workspace setup.                                                          |
| Full core               | 10 × 5 × 3             |       150 |        30 | Main comparison: off, flat notes, seeded, seeded without public fallback, natural. Weekly/release/manual; ready PRs require `ci` plus `benchmark: headline`. |
| Seeded canary           | 2 × 2 × 1              |         4 |         0 | Alias/workspace health check. Ready PRs use `ci`; adding it and subsequent pushes run the canary. Main pushes/nightly/manual supply baselines.               |
| Recursive diagnostic    | 1 × 4 × 3              |        12 |         3 | Manual delegated diagnosis and capture/delivery check.                                                                                                       |

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

The reduced preflight is 9 model sessions instead of 72: allow roughly 20–40 minutes including
setup if healthy sessions take 1–2 minutes. This is a planning assumption, not a measured result.
Its session-cap ceiling is 90 minutes before setup and verification. Full core remains 180 model
sessions: the earlier conditional 4–8 hour planning allowance has not been validated by a healthy
current-container run. The existing launch failures must be resolved before forecasting from it.
GitHub-hosted jobs stop at six hours; the caller's 720-minute timeout cannot override that limit.
Resume/sharding remains Bench-1 work. Codex CLI execution is also pending shared framework work.
