# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only.
Every command here runs from a venv built from `requirements-test.txt`, which is the package's
whole hash-pinned closure: pytest and inline-snapshot for the suite, scipy for the reducer's
interval, jsonschema for the validators. This package measures trials: for one task and
one quality bar, how many model tokens did the complete agent run consume with and without a
knowledge system. It does not itself produce a savings number, and nothing here touches the
product runtime.

**What this layer owns.** Bench-1 is the shared framework for all experiments, split into
four reviewable layers: accounting/reporting, container execution, the full reusable fixture
library, and configuration/CI. This first layer includes usage and immutable records, phase
accounting, uncertainty, report rendering, explicit-baseline regression, saved-case export,
signature parsing, and synthetic inputs that exercise the offline chain. The execution layer
adds the shared container runtime and live adapters. The corpus layer adds the full task and
lesson library; the configuration layer adds reusable workflow callers. Bench-2 and Bench-3
select experiments on that same framework.

Plan: `tenjin-notes/plans/2026-09-04-developer-token-savings-benchmark.md`. Historical run
records remain in `tenjin-notes`; provisional runtime numbers are not compatibility contracts.
The target headline measures time and tokens to verified task completion. Existing rendered
capture/amortization diagnostics remain provisional until the planned metric hardening lands.

Four things Bench-1 does not measure and will not be made to measure: the product's own `tokens
saved` counter, which is computed from product state and so can never judge the product; `tenjin
grade`, which stays explanatory while the hidden verifier decides pass and fail; provider
usage-limit percentages and surge multipliers, which move for reasons unrelated to tokens; and an
LLM judge, which if ever added is benchmark overhead in its own field, neither product cost nor
correctness. The outcome is raw provider token counts under an executable verifier; subscription dollar cost is supplementary.

## Shared local and CI execution

Local and CI runs use the same container runner, images, Docker Compose lifecycle, verifier,
and reporting commands. Colima can provide Docker on macOS. Put run directories on a path
shared with the Docker VM. The fake executor is an offline test double, not a second live runner.
Build images with `python3 -m evals.benchmark.images --help`, then pass an explicit manifest to
`python3 -m evals.benchmark.cli live-run --manifest PATH --out RUN`. Use `--dry-run` to inspect
that same launch without starting it. Install `requirements-live.txt` for live execution.

Every live attempt captures stdout and stderr, settles usage from retained transcripts and the
stream envelope, and tears down its Compose project. After an interrupted run, `cleanup --run RUN`
removes only projects recorded by that run. Provisioning, corpus reset, producer/consumer phases,
images, and HTTP snapshot transport are shared framework capabilities. The full fixture library
and concrete preset/configuration data arrive in the next two layers.

## Read the result at a glance

Every text summary and CI check starts with the experiment identity, model/harness, task list,
planned versus recorded attempts, and a row for every arm. Verified completions, failed/capped/
invalid attempts, consumer seconds per completion, and tokens per completion stay together.
The table labels the control and shows percentage changes only for a complete measured run.
Synthetic tests and plumbing smokes explicitly say they contain no product result; missing
attempts or incomplete accounting cannot masquerade as a completed comparison.

The current completion figures divide scored consumer spend by verified passes within each
task, then weight tasks equally. Failed and capped work remains in the numerator. Consumer
time includes shutdown and settlement, and excludes setup, producer work and hidden verification.
Producer/capture amortization and existing intervals are diagnostic details below the overview.
Endpoint and completion-metric uncertainty hardening are still required before a product claim.

## Layout, and where each contract lives

Each contract is stated once, in the module that owns it, and held by the test module beside it.
The tests are the specification to reach for: each names its rule and holds to it on a fixture
the suite builds.

| Module                  | What it owns                                                      | Held by                              |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `manifest.py`           | frozen manifest: load, validate, hash, fixture hash over the tree | `test_manifest.py`                   |
| `schema.py`             | JSON Schema checking under each module's own refusal              | `test_manifest.py`                   |
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
| `cli.py`, `selftest.py` | the commands, and the offline entry the required lane runs        | `test_fake_run.py`                   |

The data beside them: `fixtures/fake/` (the manifest and repo `fake-run` drives, the null
manifest beside it, and the bootstrap golden) and `fixtures/claude/` (sanitized synthetic Claude sessions; no real
transcript). The full real-repository fixture library and hidden layers arrive in the corpus layer.
Regression requires an explicit baseline. The planned CI policy selects the last corresponding
completed main run; the promoted plumbing workflow still supplies its provisional baseline.

## Its CI lanes

The offline suite is a step of the required `CI` workflow, on every pull request with no path
filter: the interpreter floor, the pinned test dependencies installed into a throwaway venv,
`selftest.py` run from that venv, then the fake manifest driven to a published report, the hidden
verifiers re-run over it, and `summary` printed to the run page. The venv is built from the
runner's own `python3`, floor 3.12, and a runner below the floor fails rather than skips, because a
skipped gate reads like a passing one. The one install is `requirements-test.txt`, which is the
package's whole closure and not just the suite's: exact versions with every transitive dependency
pinned by hash, so the required check never depends on what the index served that minute. scipy,
numpy and rpds-py ship platform wheels, so those carry one hash per wheel across CPython 3.12 to
3.14 on manylinux x86_64 and macOS arm64. Every step from the install onwards runs that venv's
interpreter, `fake-run`, `verify` and `summary` included. Each step's own timeout bounds it.

## Where a dependency may go

One line decides it, and it is not line count: reach for a maintained library
before hand-rolling. `requirements-test.txt` is the package's whole closure,
suite and shipped commands alike, so there is no stdlib-only side to keep.

- **A published number's method should be a citable one.** `paired_bootstrap`
  is `scipy.stats.bootstrap` at `method="percentile"`, seeded from the
  manifest, because "the percentile bootstrap as scipy implements it" is a
  method line a reader can check and a hand-rolled rank rule is not. What the
  package still owns is the sampling unit: one ratio per task, so a task with
  more repeats cannot speak louder.
- **A schema keyword should be a schema keyword.** The shape half of
  `manifest.py` is one JSON Schema document, checked by `jsonschema` through
  `schema.check`, which raises the caller's own error class so a refusal stays
  the refusal the contract names. What stays written out is every rule a schema
  cannot state: the ones that cost money, that let an arm widen its own pins,
  or that read something outside the document (a fixture on disk, the hash of
  its bytes, a constant this package computes at import).
- **A new pin is a real cost.** Each one is exact, hashed, and installed by a
  required check on every pull request, and a platform wheel is one hash per
  runner and per Python minor. Add one when it replaces logic this package
  should not be maintaining, not to save a few lines.

## The fake command

```bash
# Everything below runs from a venv built from this file. Once, into one of your choosing:
#   python3 -m venv .venv && .venv/bin/python -m pip install --require-hashes \
#     --only-binary=:all: -r evals/benchmark/requirements-test.txt
python -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python -m evals.benchmark.cli verify --run /tmp/bench1-fake
python -m evals.benchmark.cli summary --run /tmp/bench1-fake
python evals/benchmark/selftest.py
pytest -c evals/benchmark/pytest.ini    # the same cases, with pytest's own selection flags
pytest -c evals/benchmark/pytest.ini --inline-snapshot=fix   # rewrite the goldens in place
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
whether the corpus holds an expensive task at all. Claude transcript discovery counters are
reported only for the supported native format; Codex discovery is unavailable, never inferred
as zero from unparsed events. Verified completion, native tokens, timing and hook delivery
remain separately measured. It prints at most `report.CORPUS_ROWS` of
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

Time and tokens to verified completion are both measured. Only trials with isolated mutable
state may overlap; concurrency is part of the protocol, not an invisible runtime tweak. A provisioning arm seeds its lesson into the one shelf the operator's account owns,
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
order they finish in, and no trial id, hash, or balance property depends on the degree.

## Execution boundary

The foundation injects `Runtime.spawn` and owns the common result/accounting contract. Its
host subprocess helper is for synthetic offline tests. #335 supplies the shared container
implementation used by both local and CI live runs. No host-daemon lifecycle or package-manager
cache is part of this foundation. Credential exposures are observable; attempted blocked
network requests are not, and the record does not claim that counter.

## Cleanup

Every process this package starts leads its own session, and the spawn kills the whole group on
its way out whatever happened, an interrupt included. A harness SIGKILLed mid-trial leaves that
child reparented to pid 1 and nothing reaps it, which is a cost this package accepts rather than
a gap: this seam runs the fake and offline executors, which start no model and spend nothing.

Never clean up by matching a process name. A pattern such as `pkill -f bin/claude` also matches
the operator's own unrelated sessions, and on 2026-09-07 exactly that command, run to tidy one
spawned child, killed every other Claude Code session on the machine. The ban is executable
rather than remembered: a test parses every module here and fails on a name-matching kill.

## Native usage adapters

Claude and Codex normalize native per-request receipts into the same session evidence contract.
The Codex parser is pinned to CLI 0.154.0 and `gpt-5.6-sol`; it checks native session/parent IDs,
model context and cumulative thread totals. Only `token_usage_record.usage` is additive. The
exec total is a cross-check, never another request. Missing optional category presence remains
unknown. These receipts are best-effort provider evidence; the CLI cannot prove a provider never
omitted usage. The live Codex launch/activation integration is a separate container-layer concern.

`pins.speed_mode` records the requested `standard` or `fast` service configuration, identically
across arms. Readouts state the request rather than claiming provider acceptance. Claude remains
standard for subscription-only runs because its fast mode requires separate usage credits.

## Subscription container execution

The live adapters share Harbor/Docker Compose locally and in CI. Codex pins CLI 0.154.0,
`gpt-5.6-sol`, explicit reasoning effort and ChatGPT login. Supply a private 0600 auth-only
file through `CODEX_BENCH_AUTH_FILE`, outside the run directory. API-key authentication is
refused. The generated profile mounts only that file, not the operator's Codex home.
One Codex trial runs at a time because refresh writes share the managed credential.

Subscription login does not itself disable a provider account's credit fallback. Before a
live run, verify that purchased-credit/extra-usage fallback is unavailable or disabled. Never
buy credits, enable extra usage, redeem resets or switch to API billing to finish a run.
Codex fast mode may use included allowance faster. Claude fast mode is always disabled here
because it requires separate credits. Provider exhaustion saves the partial report, stops new
trial admission and produces UNAVAILABLE, not a product pass or a usable main baseline.

The pinned Codex build uses legacy Landlock inside default-privilege Docker containers;
protected workspace metadata directories are also mounted read-only. Image-owned protected
names under `/tmp` keep the native policy representable. The native default Bubblewrap path
cannot create its namespace under this container policy. No extra Docker privileges are used.
Native JSON stdout and diagnostic stderr are retained separately for strict reconciliation.

The coordinator fills free workers with independent trials while admitting only one trial
that provisions the shared shelf. A cleanup failure stops further admission. Run-directory
leases protect local writers; CI owns the shared shelf through its workflow concurrency group.
Start a resumable corpus run with `--freeze-corpus`; every continuation restores its saved
source LSN, validates source generation and the settled target revision, and retains a unique
reset receipt. `--max-new-trials N` executes at most N additional trials while retaining the
full schedule and incomplete-coverage status. Repeat the same command/output directory to
continue, or add `--until-complete` to repeat chunks under one resource lease.
`--admission-seconds N` stops new admissions after N seconds; active trials finish and
checkpoint. A changed benchmark runtime refuses frozen continuation before provider calls.
These chunks need not be independently balanced; only the complete schedule supports
the complete experiment. Without a frozen baseline, retained corpus evidence refuses before reset.
Offline and corpus-free runs also preserve full-schedule identity across continuation.

`--neon-cli` uses an existing Neon CLI login through the same guarded provider contract as CI's
API credential. A target-scoped local lease prevents two runs from resetting the same branch
through different origin aliases; CI additionally serializes the shared shelf workflow.
Changed source generation, expired restore history, missing/modified epoch receipts or a
changed schedule refuse continuation without falling back to parent head. Each report retains
all reset epochs beside one logical baseline identity. This freezes initial Postgres state;
it does not freeze an independently deployed application or external search/cache state.

Producer records retain agent and verifier duration separately. Capture-token attribution uses
each actor's own stop boundary; child capture before the root finishes cannot be mislabeled as
ordinary producer work. The primary time endpoint remains consumer execution per completion;
producer task work and total pipeline latency must not be inferred from that label.

## Completion readout

The first table reports verified/planned attempts, failures/caps/invalid attempts, consumer
execution seconds and system tokens per verified completion. Within each task, all scored
attempt spend is divided by verified passes; the displayed arm averages those task cells.
A task with no pass makes its completion endpoint unavailable. Incremental capture is charged
at reuse 1, while producer task work and reuse 2/5/10 remain separate diagnostics.

`agent_time_s` brackets the actual agent process, including its tools and hooks. Container
startup/shutdown, settlement, producer work and hidden verification are excluded; verification
and harness elapsed time have separate fields. Missing timing stays unavailable rather than
falling back to the older harness clock. Failed/capped consumer time is retained.

Completion comparisons use a paired task bootstrap of the displayed ratio of means, plus a
paired pass-rate difference. Unequal task cohorts cannot produce a comparison. A single task
has a point estimate and no confidence interval. Repeated attempts are not independent tasks.
The regression protocol includes the measurement-method version, so older main artifacts with
different endpoints cannot silently become this method's baseline.

## Four rules that cut across every contract

- **The five outcomes stay distinct.** `pass` and `fail` come from the hidden verifier, which
  runs after shutdown on a copy of the final worktree with the code-owned hidden layer mounted;
  `capped` (a wall-clock, budget, or turn stop) and `interrupted` (descendants that never
  settled) are task outcomes that keep every token they spent; `invalid` means the measurement is
  incomplete or contradictory and never scores. `invalid` is never a miss, never a failure, and
  never a zero-token run, and its reason names the gate that refused it (`executor:exit_N`,
  `usage:<code>`, `delivery:<code>`, `verifier:<id>`, `auxiliary:<code>`, `provision:<code>`,
  `isolation:symlink_escape`, `sentinel:credential_exposure`).
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
`repo/`, which `fake-run` drives, `nop-manifest.json`, which is that manifest with the null
executor and whose every trial must FAIL, and `bootstrap-golden.json`, the seeded inputs and
deterministic fields of `paired_bootstrap`. Everything else the offline suite needs is built: `tests/support.py` writes manifests,
sessions, records, and a whole finished run (`fake_corpus`) through the same code paths a real
run uses, so regenerating a fixture moves its expectation with it.

Two rules about what the offline suite pins. The fake path asserts BOTH polarities: the shipped
manifest's every trial passes, and `nop-manifest.json`, identical but for its executor, has to
fail every trial and score 0.0, because a chain that only ever succeeds cannot tell a working
verifier from one that returns `pass` whatever it is handed. And the bootstrap interval is
asserted as invariants, `low <= point <= high` with `low < high` whenever two ratios differ,
rather than by pinned endpoints: `point` is a plain mean and is a fact, while the endpoints are
resample means, so freezing them froze `random.Random`'s draw order rather than the contract. The
amortization series at reuse 1, 2, 5 and 10 stays pinned exactly, because it is deterministic
arithmetic over the reduction and a moved value there is a real change.

The full reusable Vitest fixtures and lessons belong to the Bench-1 corpus layer, with hidden
verifiers under `hidden/<task>/hidden-tests/`. Bench-1's shared container image build installs
each fixture's dependencies. Local and CI live runs use that same runtime, including Docker
Compose on Colima; later benchmarks add experiment selections and results on top of it.

## Extending the foundation

Later benchmarks add experiments and results. Reusable adapters and reporting belong in Bench-1. A new task is a manifest
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

The internal `bench2-` image/container names and marker filenames are retained implementation
identifiers from the original container runner. They name shared Bench-1 infrastructure and
are used unchanged by every experiment, locally and in CI.

Portable checkpoints contain the original nonce, full schedule, validated final records with
private refusal text removed, and the frozen corpus/epoch receipts. They contain no trial
worktrees, model transcripts, profiles or credentials. Export from a stopped run and import
into an empty directory using the same checkout revision and manifest:

```sh
python -m evals.benchmark.checkpoint export --run RUN --out CHECKPOINT --manifest MANIFEST --revision GIT_SHA
python -m evals.benchmark.checkpoint import --run CHECKPOINT --out RESUMED_RUN --manifest MANIFEST --revision GIT_SHA
```

Continuation preserves accepted final attempts, including invalid ones. It does not retry a
recorded quota/instrumentation failure or erase its spend. After such a failure, retain the
partial evidence and start a fresh run when the cause is fixed; clean deadline checkpoints
can continue without repeating completed work.

The importer verifies file inventory and hashes, runtime revision, Git revision, manifest,
full schedule and every referenced epoch before writing. It rewrites only the local manifest
path and preserves the nonce. Then use the ordinary `live-run --freeze-corpus` command against
RESUMED_RUN. Re-verification of retained worktrees remains an explicit `verify` command; a
record-only checkpoint has no worktree to re-verify and uses the recorded hidden verdict.

CI uses `admission.py` to subtract elapsed setup, the longest producer-plus-consumer model
caps and a conservative cleanup/upload reserve from the job timeout. It is a practical margin,
not a guarantee against a stalled external service. Deadline stops retain incomplete coverage.
The reusable workflow accepts an explicit prior run/artifact pair for recovery; it never picks
an arbitrary latest checkpoint. A different tested commit or runtime requires a fresh run.
