# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only,
stdlib Python only. This package measures trials: for one task and one quality bar, how many
model tokens did the complete agent run consume with and without a knowledge system. It does
not itself produce a savings number, and nothing here touches the product runtime.

Plan: `tenjin-notes/plans/2026-09-04-benchmark-foundation.md`. This README is a stub; the
reduction and reporting commit group completes it.

## Layout

```
evals/benchmark/
  manifest.py      frozen manifest: load, validate, hash
  schedule.py      balanced, seeded schedule; trial_id and schedule SHA-256
  records.py       immutable attempt record: partial write, flush, publish without overwrite
  usage.py         UsageRecord contract, arithmetic validation, null-vs-zero, dedupe, totals
  claude_usage.py  Claude JSONL usage adapter (group by requestId, never sum rows)
  loop_join.py     read-only projection of a stopped trial's loop.db onto exact actor keys
  runner.py        executes a schedule: fresh roots, settlement, timeout, resume
  executor.py      executor registry (code-owned argv, shell=False) and the fake executor
  verifier.py      hidden verifier registry and the fake verifier
  artifact.py      disposable trial roots and the post-shutdown verifier copy
  reduce.py        failure-inclusive task-equal reducer
  report.py        publishable projection and its redaction guard
  cli.py           fake-run | reduce | report
  selftest.py      offline unittest entry (what src/evals-benchmark.test.ts runs)
  tests/           unittest modules
  fixtures/fake/   the fake manifest and fake repo
  fixtures/claude/ sanitized native JSONL fixtures (synthetic, no real transcripts)
```

## The fake command

From the repository root:

```bash
python3 -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python3 evals/benchmark/selftest.py
```

`fake-run` loads `fixtures/fake/manifest.json`, writes the expanded schedule and its SHA-256,
runs a fake root plus one fake child per trial through the executor registry, runs the fixed
fake verifier on a post-shutdown copy of the worktree, publishes one immutable record per
attempt, reduces them, and writes `report.json`. Running it again against the same `--out`
resumes: every published record that validates against the current manifest and schedule
hashes is skipped. No model, no network, no spend.

Everything under `--out` except `report.json` is private. The report carries counts, enums,
opaque ids, and hashes only; `report.guard` refuses anything else.

There is no live command yet. A live run is operator-only and refuses to publish without the
disposable container or VM attestation the plan requires.
