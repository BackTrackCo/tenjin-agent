# Bench-2 local-reuse experiments

Bench-2 selects tasks, treatments, producer/consumer protocol, repeats and caps from the shared
Bench-1 framework. It adds no runtime, reporting engine, or replacement fixture library.
`experiments.py` names the pilot, core, canary, high-discovery and recursive configurations.
`benchmark-canary.yml` and `benchmark-headline.yml` select when to call Bench-1's reusable
`benchmark-shelf.yml`. The `benchmark-live.yml` dispatch bridge selects the canary on demand.

Use the same `images build` and `cli live-run --manifest PATH` commands locally and in CI.
Docker Compose runs against Docker or Colima locally. The shared framework handles execution,
verification, phase accounting, reports, artifacts and cleanup. Results and historical runs
belong in `tenjin-notes/benchmark/` and its audits. No provisional number here is hardened.

The next planned framework work stays in Bench-1: error visibility, main-run regression
selection, time/token completion metrics and Codex CLI support. Bench-3 adds team-representative
experiments on the same framework.

## Configured experiments

All selections currently use Claude Code and one trial at a time. Producer sessions are
additional model work, separate from the consumer attempt count.

| Selection                 | Tasks × arms × repeats | Consumers | Producers |
| ------------------------- | ---------------------- | --------: | --------: |
| Natural-reuse pilot       | 8 × 2 × 3              |        48 |        24 |
| Full core                 | 10 × 5 × 3             |       150 |        30 |
| Seeded canary             | 4 × 2 × 3              |        24 |         0 |
| Full corpus diagnostic    | 10 × 2 × 3             |        60 |         0 |
| High-discovery diagnostic | 2 × 2 × 3              |        12 |         0 |
| Recursive diagnostic      | 1 × 4 × 3              |        12 |         3 |

A configured experiment is not a completed result. Read the report's status and verified versus
planned attempts before interpreting time or token comparisons. Run state, retained historical
results and conditional duration estimates are recorded in the benchmark plan in tenjin-notes.
The full-core workflow's 720-minute setting cannot extend GitHub-hosted execution beyond six
hours; reliable long runs require the shared resume/sharding work in Bench-1.
