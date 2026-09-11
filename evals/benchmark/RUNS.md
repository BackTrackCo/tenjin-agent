# Bench-1 run configuration

This layer selects the Bench-1 experiments. Execution and accounting live in the benchmark
package; actor/lesson/verifier content lives in the corpus. These manifests and workflow
retain their existing treatments, pins, counts and triggers during extraction.

Read the benchmark README for execution, isolation and artifact contracts. Always pass
`--manifest <path>` to `live-run` and `--baseline <path>` to `regress`. Shipped configuration
checks live in `tests/test_live_configuration.py`; they run without a model.

## Live plumbing workflow

The live plumbing smoke is `benchmark-live.yml`, on a pull request touching `evals/benchmark/**`
and on dispatch: a pinned Claude Code, `live-run --plumbing --ci-live` over the smoke manifest
with `CLAUDE_CODE_OAUTH_TOKEN` on that one step, then `verify`, `summary`, `regress`, and
`report.json` uploaded alone. Every record is stamped automated and non-publishable, so the
lane is evidence that the chain runs on a real agent and never a number anyone may quote. It is
informational: not required, never blocking, and not `continue-on-error` either, because a red
run is meant to be seen; on a fork the secret is absent and the live steps skip.

## Smoke selections

`fixtures/live/smoke-manifest.json` is a plumbing smoke, not a task set: one trivial task under
the fixed hidden verifier, two arms differing by a marker in their settings, two repeats. Gate 3
of the plan is four to eight live attempts of it, and what they prove is plumbing (disposable
isolation, recursive settlement, usage capture from real transcripts, verifier execution after
shutdown, the sentinels), never a savings claim; `fixtures/live/baseline.json` holds the last
operator run's per-arm figures and the 25% tolerance `regress` warns against. The two
real-repository smokes, `hooks-smoke-manifest.json` and `keys-smoke-manifest.json`, one per
delivery path, belong to this Bench-1 configuration layer; Bench-2 later replaces their runtime with container images; an operator runs them with `live-run
--manifest <manifest> --out <dir> --plumbing --tenjin-source <tenjin data dir>`, and neither ever
runs in CI, a refusal that lives in code rather than in the workflow.

The committed September 7 baseline remains a provisional input to the existing regression
command at this layer. Bench-2 reporting/configuration replaces it with the latest corresponding
main-run artifact for PR comparisons. Removing the old data must not remove regression coverage.
