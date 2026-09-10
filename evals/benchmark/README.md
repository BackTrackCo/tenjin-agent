# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only.
Every shipped command is standard-library Python; the offline suite is the one part that
installs anything, and it installs exactly pytest. This package measures trials: for one task and
one quality bar, how many model tokens did the complete agent run consume with and without a
knowledge system. It does not itself produce a savings number, and nothing here touches the
product runtime.

**What this layer owns.** Bench-1 ships as three stacked layers, and this is the first: the
whole offline chain. The frozen contracts (manifest, schedule, immutable record, usage), the
executor and verifier registries with their fake specs, disposable roots, sentinels and the
isolation attestation, the reducer, the report and its headline rule, and the `verify`,
`reduce`, `report`, `summary` and `cleanup` commands. `fake-run` drives all of it end
to end with no model, no network and no spend, which is what the required CI lane runs and what
this layer is for: the measurement machinery has to be trustworthy before anything real runs
through it. The layer above adds the live executor, the vendored toolchain it needs, the
`sig_v1` port, the `regress` warning and the Tenjin hooks arm; the one above that adds the
corpus reset and the search-intent case export.
Bench-2 (PR 313) then owns every real fixture as a container image, the four arms, the producer
phase, and the readouts.

Plan: `tenjin-notes/plans/2026-09-04-benchmark-foundation.md`. Run history through 2026-09-08,
which is where the smoke runs, the retrieval findings, the corepack saga, and the pilot readout
live: `tenjin-notes/audits/2026-09-08-bench1-runs/README.md`. Every contract below is frozen:
changing one is a benchmark version bump, not an edit.

Four things Bench-1 does not measure and will not be made to measure: the product's own `tokens
saved` counter, which is computed from product state and so can never judge the product; `tenjin
grade`, which stays explanatory while the hidden verifier decides pass and fail; provider
usage-limit percentages and surge multipliers, which move for reasons unrelated to tokens; and an
LLM judge, which if ever added is benchmark overhead in its own field, neither product cost nor
correctness. The outcome is raw provider token counts under an executable verifier; cost and wall
time are secondary.

## Layout, and where each contract lives

Each contract is stated once, in the module that owns it, and held by the test module beside it.
The tests are the specification to reach for: each names its rule and holds to it on a fixture
the suite builds.

| Module                  | What it owns                                                      | Held by                              |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `manifest.py`           | frozen manifest: load, validate, hash, fixture hash over the tree | `test_manifest.py`                   |
| `schedule.py`           | balanced seeded schedule, `trial_id`, schedule SHA-256            | `test_schedule.py`                   |
| `runner.py`             | execution: fresh roots, settlement, caps, resume, concurrency     | `test_runner.py`, `test_fake_run.py` |
| `executor.py`           | executor registry (code-owned argv, `shell=False`), fake agents   | `test_artifact.py`                   |
| `artifact.py`           | disposable roots, sentinels, the isolation attestation            | `test_artifact.py`                   |
| `verifier.py`           | hidden verifier registry, code-owned argv, the hidden layer       | `test_verifier.py`                   |
| `usage.py`              | usage and receipt arithmetic, null-vs-zero, dedupe                | `test_usage.py`                      |
| `claude_usage.py`       | the Claude JSONL adapter and its reconciliation                   | `test_claude_usage.py`               |
| `records.py`            | the immutable attempt record, publish, select                     | `test_records.py`                    |
| `loop_join.py`          | read-only delivery join on exact actor keys                       | `test_loop_join.py`                  |
| `reduce.py`             | task-equal reduction, amortization, seeded bootstrap              | `test_reduce.py`                     |
| `report.py`             | publishable projection, redaction guard, the headline rule        | `test_report.py`                     |
| `discovery.py`          | the discovery counters read off a settled trial                   | `test_discovery.py`                  |
| `reap.py`               | cleanup by recorded identity, never by process name               | `test_reap.py`                       |
| `cli.py`, `selftest.py` | the commands, and the offline entry the required lane runs        | `test_fake_run.py`                   |

The data beside them: `fixtures/fake/` (the manifest and repo `fake-run` drives, and the
bootstrap golden) and `fixtures/claude/` (sanitized synthetic Claude sessions; no real
transcript). The real-repository fixtures, their vendored archive, the regression baseline and
the code-owned hidden layers arrive with the live executor in the layer above.

## Its CI lanes

The offline suite is a step of the required `CI` workflow, on every pull request with no path
filter: the interpreter floor, one pinned pytest installed into a throwaway venv,
`selftest.py` run from that venv, then the fake manifest driven to a published report, the hidden
verifiers re-run over it, and `summary` printed to the run page. It runs on the runner's own
`python3`, floor 3.11, and a runner below the floor fails rather than skips, because a skipped
gate reads like a passing one. The one install is `requirements-test.txt`: pytest at an exact
version with every transitive dependency pinned by hash, so the required check never depends on
what the index served that minute. Nothing else in the package needs it, so the `fake-run`,
`verify` and `summary` steps beside it still call a bare interpreter. The whole chain takes about
20 seconds, and each step's own timeout bounds it.

## The fake command

```bash
python3 -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python3 -m evals.benchmark.cli verify --run /tmp/bench1-fake
python3 -m evals.benchmark.cli summary --run /tmp/bench1-fake
# The suite alone needs pytest. Once, into a venv of your choosing:
#   python3 -m pip install --require-hashes --only-binary=:all: \
#     -r evals/benchmark/requirements-test.txt
python3 evals/benchmark/selftest.py
pytest evals/benchmark/tests            # the same cases, with pytest's own selection flags
```

`fake-run` loads `fixtures/fake/manifest.json`, writes the expanded schedule and its SHA-256,
runs a fake root plus one fake child per trial through the executor registry, runs the fixed fake
verifier on a post-shutdown copy of the worktree, publishes one immutable record per attempt,
reduces them, and writes `report.json`. Running it again against the same `--out` resumes: every
published record that validates against the current manifest and schedule hashes is skipped. No
model, no network, no spend. `verify` re-runs each accepted attempt's hidden verifier and names
the trials where a fresh verdict disagrees with the recorded one; `reduce` and `report` rebuild
the aggregates and the projection from the immutable records alone; `summary` reads a finished
`report.json` as text and computes nothing, printing every arm rather than the best one, because
an arm shown alone is a claim rather than a result.

The readout ends with the corpus every number above was measured on: one row per task carrying
its family, transfer distance, verifier and fixture hash from the manifest, and its round trips,
tokens per attempt and pass rate in each arm from the reduction. The rows are ordered by
discovery cost, the baseline arm's requests per attempt, most expensive first, which is what says
whether the corpus holds an expensive task at all. It prints at most `report.CORPUS_ROWS` of
them, because a check run's `output.summary` is capped at 65,535 characters and truncates
silently past it; a corpus longer than that ends with a line naming how many cheaper tasks were
left out, and `report.json` carries all of them under `corpus_tasks`.

Everything under `--out` except `report.json` is private. The report carries counts, enums,
opaque ids, and hashes only, plus the run's isolation stamp: `publishable`, `isolation` (`fake`,
`attested`, `operator_plumbing`, `automated_plumbing`, or `team_shelf_secret`),
`shelf_secret_present`, `automated`, and the `corpus` a reset stamped. One non-publishable record
makes the whole report non-publishable and no comparison in it headline eligible, and `summary`
says so in its header.

## The isolation attestation, and what an operator prepares

```json
{
  "kind": "container",
  "instance_id": "bench1-smoke-01",
  "image": "ghcr.io/example/bench1@sha256:0000",
  "fresh_roots": true,
  "wallet_present": false,
  "credential_seam": "CLAUDE_CODE_OAUTH_TOKEN",
  "network_allowlist": ["api.anthropic.com"]
}
```

Every field is stated and none is defaulted: `kind` is `container` or `vm`, `fresh_roots` must be
true, `wallet_present` false, the allowlist neither empty, nor a wildcard, nor missing an origin
the executor requires, and `credential_seam` the variable `pins.credential_env` names. Its hash
goes into every record, so a published result names the isolation it ran under.

The operator prepares a disposable container or VM booted from a pinned image and thrown away
after the run; fresh home, profile, data, repository, and output roots, which the run directory
owns; no wallet in the image or the environment, and no shelf secret; the model credential in exactly one allowlisted variable
named by `pins.credential_env`; network allowlisted to the provider plus the arm under test,
matching the attestation; and `pins.image`, `pins.harness_version`, and `pins.model` set to what
this instance actually runs. Project-scoped tool permissions and transcript redaction are
retention controls, not an operating-system sandbox, and a temp directory does not isolate a
keychain (tenjin-agent#71).

## Running trials at once

`pins.concurrency` is how many trials may be in flight, and it defaults to one, so a manifest
that does not name it runs exactly as it always has. It is a pin because `environment_hash` is
the hash of the pins: two runs at different degrees are already distinguishable in every record,
and `report.json` states the number so a reader comparing two runs does not have to open one.

The measurement is in tokens, so wall clock is overhead, but only trials that provision nothing
may overlap. A provisioning arm seeds its lesson into the one shelf the operator's account owns,
searches it through the product, and deletes it at the end; two seeded windows inside each other
would let one trial's search answer with the other's piece, a duplicate for two trials of one
task and a false positive for two tasks, in exactly the delivery numbers this benchmark exists to
measure. A failed publish is worse still: `sweep_stamped` clears by title rather than by stamp,
so it would delete a concurrent trial's live seed. So `runner.run` holds one mutual exclusion for
the whole of a provisioning trial, covering the publish, the agent's searches, the delete, and
the free port its daemon claimed, and lets everything else run freely. A four-arm matrix with one
unprovisioned arm converges on the time its provisioned arms take alone, and the gain is the
unprovisioned quarter hiding inside that.

The schedule is untouched: trials are assigned in its order, the results come back in it whatever
order they finish in, and no trial id, hash, or balance property depends on the degree. A run
with a sentinel attached is refused above one, because the sentinel is one server for the whole
run and its hits name no trial, so a trial claims whatever arrived while it ran.

## Cleanup

Every process this package starts leads its own session, and its group is recorded under
`<run>/pids/` before the run waits on it. The spawn kills the group and clears the record on its
way out whatever happened, an interrupt included. If a run is killed outright, `cli.py cleanup
--run <dir>` reads the ledger, and before signalling anything checks each record against the live
process: same start time and same process group, or the record is dropped unkilled. A pid is
reused, so killing a recycled one kills a stranger.

Never clean up by matching a process name. A pattern such as `pkill -f bin/claude` also matches
the operator's own unrelated sessions, and on 2026-09-07 exactly that command, run to tidy one
spawned child, killed every other Claude Code session on the machine. The ban is executable
rather than remembered: a test parses every module here and fails on a name-matching kill.

## Four rules that cut across every contract

- **The five outcomes stay distinct.** `pass` and `fail` come from the hidden verifier, which
  runs after shutdown on a copy of the final worktree with the code-owned hidden layer mounted;
  `capped` (a wall-clock, budget, or turn stop) and `interrupted` (descendants that never
  settled) are task outcomes that keep every token they spent; `invalid` means the measurement is
  incomplete or contradictory and never scores. `invalid` is never a miss, never a failure, and
  never a zero-token run, and its reason names the gate that refused it (`executor:exit_N`,
  `usage:<code>`, `delivery:<code>`, `verifier:<id>`, `auxiliary:<code>`, `provision:<code>`,
  `isolation:symlink_escape`, `sentinel:public_request`, `sentinel:credential_exposure`).
- **Every task weighs the same.** A cell is one `(arm, task)` pair and an arm figure is the mean
  over its cells, never a sum over attempts, so a task with more repeats does not speak louder.
  Pass rate and token ratio are separate axes and nothing folds them into one number. Producer
  and capture receipts leave the per-attempt numerator, count once per native request id, and
  come back through `amortization` at reuse 1, 2, 5, and 10.
- **An arm that cannot account for its spend cannot enter a headline.** A reconciliation outside
  `matched`, `matched_with_descendants`, and `explained_by_side_models` is accounting-incomplete,
  as is a declared `auxiliary_usage: unexposed`; a declared cap is `partial_by_cap` and stays
  eligible, because the gap is named by the outcome. The ratio is still computed and shown; it is
  the headline flag, not the arithmetic, that refuses to trust it.
- **Everything but `report.json` is private.** Transcripts, worktrees, stores, prompts, memory
  bodies, patches, and the disposable roots never leave the run directory, and records carry
  hashes of them rather than bodies or host paths. A publishable string is a SHA-256 token or an
  opaque token of at most 64 characters from `[A-Za-z0-9_.:+-]`, so a path separator, a space, a
  newline, or a quote is a refusal by construction and prose cannot be spelled at all.

Where this README and a module disagree, the module and its tests are right.

## Fixtures

`fixtures/claude/sessions/` holds one synthetic session per adapter case (root-only, family,
flat, retry, categories, null-zero, fallback, malformed, duplicate, capped, capped-turns,
capped-budget, ambiguous, mismatch, side-models): the frozen row shapes the Claude adapter reads.
Real transcripts are never read, and the `loop.db` fixture is built at test time from the
product's own `LOOP_DDL` in `src/hooks/store.ts`. `fixtures/fake/` holds `manifest.json` and
`repo/`, which `fake-run` drives, and `bootstrap-golden.json`, the frozen `paired_bootstrap`
output for four seeded inputs, which is the reducer's pre-registration freeze of the interval
method. Everything else the offline suite needs is built: `tests/support.py` writes manifests,
sessions, records, and a whole finished run (`fake_corpus`) through the same code paths a real
run uses, so regenerating a fixture moves its expectation with it.

The operator-side manifests, the regression baseline, the frozen Vitest task fixture, the
seeded lessons and the code-owned hidden layers under `hidden/<task>/hidden-tests/` arrive with
the live executor in the layer above, and `manifest.fixture_hash` folds the vendored archive's
digest in there. Nothing offline extracts an archive: a trial's `node_modules` is derived, never
committed, and this layer's fake tasks have none. **That whole vendored path is the darwin pin
Bench-2 replaces with a container image per task.**

## Extending the foundation

Bench-2, Bench-3, and Bench-6 add data and adapters, not architecture. A new task is a manifest
entry, a fixture directory, a hidden layer, and a verifier spec in `verifier.REGISTRY`. A new arm
is a manifest entry plus an `executor.REGISTRY` entry, and arms in one manifest share one
executor, because arms running different harnesses do not have comparable token totals; a driver
that installs a competing memory hook gets its own image, home, and data roots, and an arm
needing state on disk declares a provisioner whose seeding the record states. A new harness is
one module returning `usage.UsageRecord` per native request, with nulls for categories the
provider does not expose, plus its id in `usage.HARNESSES`. A memory product that spends tokens
of its own emits `usage.AuxiliaryReceipt` values through the `runner.Runtime.receipts` seam, and
an arm that cannot expose that spend declares `auxiliary_usage: unexposed` rather than having it
estimated from text length.

None of this changes the manifest schema, the record schema, the reducer, or the guard. A change
that does is a benchmark version bump, and a treatment-informed rewrite is always a new version.
