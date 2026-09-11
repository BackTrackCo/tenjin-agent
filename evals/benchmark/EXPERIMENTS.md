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
