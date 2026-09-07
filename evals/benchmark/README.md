# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only,
stdlib Python only. This package measures trials: for one task and one quality bar, how many
model tokens did the complete agent run consume with and without a knowledge system. It does
not itself produce a savings number, and nothing here touches the product runtime.

Plan: `tenjin-notes/plans/2026-09-04-benchmark-foundation.md`. Every contract below is frozen:
changing one is a benchmark version bump, not an edit.

What Bench-1 does not measure, and will not be made to measure:

- the product's own `tokens saved` counter. It is a product diagnostic computed from product
  state, not an independent observation, so it can never be the outcome that judges the product.
- `tenjin push grade`. It stays an explanatory field; the hidden verifier decides pass and fail.
- provider usage-limit percentages, quota depletion, and surge-hour multipliers. They move for
  reasons that have nothing to do with tokens and never enter the reducer.
- an LLM judge. A judge, if one is ever added, is benchmark overhead reported in its own field:
  it is not product cost and it is not correctness.

The outcome is raw provider token counts under an executable verifier. Cost and wall time are
secondary, and this package produces no savings claim of its own.

## Layout

```
evals/benchmark/
  manifest.py      frozen manifest: load, validate, hash; fixture directory hash
  schedule.py      balanced, seeded schedule; trial_id and schedule SHA-256
  records.py       immutable attempt record: partial write, flush, publish without overwrite
  usage.py         UsageRecord and AuxiliaryReceipt contracts, arithmetic, null-vs-zero, dedupe, totals
  claude_usage.py  Claude JSONL usage adapter (group by requestId, select one row, reconcile)
  loop_join.py     read-only projection of a stopped trial's loop.db onto exact actor keys
  runner.py        executes a schedule: fresh roots, settlement, caps, sentinels, resume
  executor.py      executor registry (code-owned argv, shell=False) and the fake executors;
                   `write_transcripts` emits a root, an optional child, and an optional
                   grandchild in the frozen Claude shapes
  verifier.py      hidden verifier registry, hidden layer, and the fixed fake verifiers
  artifact.py      disposable trial roots, sentinels, and the live-run isolation attestation
  reduce.py        failure-inclusive task-equal reducer, amortization, seeded bootstrap
  report.py        publishable projection and its redaction guard
  cli.py           fake-run | verify | reduce | report
  selftest.py      offline unittest entry (what src/evals-benchmark.test.ts runs)
  tests/           unittest modules, one per contract
  fixtures/fake/   the fake manifest and repo, the frozen attempt corpus, the bootstrap golden
  fixtures/claude/ sanitized synthetic Claude JSONL sessions (no real transcript)
```

## The fake command

From the repository root:

```bash
python3 -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python3 -m evals.benchmark.cli verify --run /tmp/bench1-fake
python3 -m evals.benchmark.cli reduce --run /tmp/bench1-fake
python3 -m evals.benchmark.cli report --run /tmp/bench1-fake
python3 evals/benchmark/selftest.py
```

`fake-run` loads `fixtures/fake/manifest.json`, writes the expanded schedule and its SHA-256,
runs a fake root plus one fake child per trial through the executor registry, runs the fixed
fake verifier on a post-shutdown copy of the worktree, publishes one immutable record per
attempt, reduces them, and writes `report.json`. Running it again against the same `--out`
resumes: every published record that validates against the current manifest and schedule
hashes is skipped. No model, no network, no spend.

`verify` re-runs each accepted attempt's hidden verifier over its retained worktree and lists
the trials where a fresh verdict disagrees with the recorded one.

Everything under `--out` except `report.json` is private. The report carries counts, enums,
opaque ids, and hashes only; `report.guard` refuses anything else.

`reduce` and `report` rebuild the aggregates and the publishable projection from the immutable
records alone, so a finished run can be re-reduced without re-running anything.

## The operator-only live command

There is no live subcommand, and no executor in `executor.REGISTRY` sets `live`, so nothing in
this repository can start a model process today. That is deliberate: the first live executor
lands with the operator live smoke, and until then CI cannot reach a live path even by
accident.

A live run is `runner.run(manifest, trials, run_dir, schedule_hash, runtime)` with a `Runtime`
the operator builds:

```python
runtime = runner.Runtime(
    publishable=True,
    attestation=artifact.Attestation(
        kind="container",           # or "vm"
        instance_id="...",          # the disposable instance this run owns
        image="...@sha256:...",     # the pinned image it booted from
        fresh_roots=True,
        wallet_present=False,
        credential_seam="env_injection",
        network_allowlist=("api.provider.example", "shelf.example"),
    ),
)
```

It runs on the operator's side only, never in CI, and only inside a disposable container or
VM: a sanitized benchmark repository, fresh home, profile, and data roots, no wallet, an
explicit model credential seam, and network allowlisted to the provider plus the arm under
test. Project-scoped tool permissions and transcript redaction are retention controls, not an
operating-system sandbox, and a temp directory does not isolate a keychain (tenjin-agent#71).
`artifact.require_isolation` enforces the part it can see: a live executor in CI is refused
outright, and a publishable live run without an attestation is refused before any spend. The
attestation hash goes into every record so a published result names the isolation it ran under.

## Execution and isolation contract

Each trial gets fresh `home`, `profile`, `TENJIN_DATA_DIR`, repository, and output roots under
`<run>/trials/<trial_id>/`, and the process sees an allowlisted environment rather than the
operator's. `runner.process_spawn` is the only place this package starts a process:
`shell=False`, its own session, and on the wall-clock pin it kills the whole process group so
a grandchild cannot outlive the trial. The clock, the settlement barrier, and the process
boundary are injected, so every offline case except the process-group one runs without real
time.

Two caps, two outcomes. The wall-clock pin ends the attempt as `capped` with `stop_reason`
`timeout`; the settlement cap (`Runtime.settle_cap_s`) ends a wait for descendants that never
produced a terminal row as `interrupted`. Both retain the usage observed so far and list the
native actor ids that never settled in `unresolved_actors` (`''` is the lead). A root that
exits while a child is live is not a complete attempt.

`pass` and `fail` come from the hidden verifier and nothing else; a verifier exit that is
neither 0 nor 1 means the measurement broke, so the attempt is `invalid`. An executor exit
code, a usage or delivery rejection, a symlink escape, and a sentinel hit are all `invalid`
with a machine-readable reason (`executor:exit_N`, `usage:<code>`, `delivery:<code>`,
`isolation:symlink_escape`, `sentinel:public_request`, `sentinel:credential_exposure`,
`auxiliary:<code>`).

The verifier runs after shutdown, never before: `artifact.TrialRoots.hidden_copy` refuses
until the roots are marked stopped, copies the worktree with links kept as links, mounts the
registry's code-owned hidden layer into that copy, and refuses a worktree holding a symlink
that resolves outside itself. `verifier.run` refuses a target outside the run directory and a
spec that does not produce an argv list, and truncates verifier output.

Sentinels make isolation observable rather than assumed. `artifact.create` plants a canary
credential in the disposable home and, when the runner is given a loopback sentinel, exports
its origin as `BENCHMARK_PUBLIC_ORIGIN`. Per attempt the runner counts new sentinel hits and
scans the roots the agent writes to for the canary; either count invalidates the attempt. The
credential scan proves the secret travelled, not that it was read.

`artifact.require_isolation` is the live-run gate. A live executor in CI is refused outright.
A publishable live run needs an `Attestation`: `container` or `vm` kind, a non-empty instance
id and image, fresh roots, no wallet, a named credential seam, and a network allowlist that is
neither empty, nor a wildcard, nor missing an origin the executor requires. Its hash goes into
the record's `isolation` field. A temp directory is not a sandbox and this package never
claims otherwise.

## Verifier and invalid-run contract

The manifest names a verifier id; it never supplies a verifier. `verifier.REGISTRY` owns the
argv, the timeout, the allowed target, and the output parser, and runs it with `shell=False`
only after every model process and memory worker has stopped. Hidden test bytes live in the
registry's code-owned hidden layer, which `artifact.TrialRoots.hidden_copy` mounts into a copy
of the final worktree after shutdown; the agent-visible mount never holds them. An unknown
verifier id, a target outside the run directory, a symlink that escapes the worktree, and a
manifest value shaped like a shell command all fail closed before the verifier runs.

Exit 0 is `pass`, exit 1 is `fail`, and any other exit or a timeout means the measurement broke
rather than the task, so the attempt is `invalid`. The five outcomes stay distinct:

| Outcome       | Meaning                                             | Usage               | Scored                 |
| ------------- | --------------------------------------------------- | ------------------- | ---------------------- |
| `pass`        | the verifier decided, correctly                     | retained            | yes                    |
| `fail`        | the verifier decided, incorrectly                   | retained            | yes                    |
| `capped`      | the wall-clock pin or a native budget ended it      | retained, partial   | yes, as a task outcome |
| `interrupted` | descendants never settled inside the settlement cap | retained, partial   | yes, as a task outcome |
| `invalid`     | the measurement is incomplete or contradictory      | retained in history | never                  |

`invalid` is never a miss, never a failure, and never a zero-token run. Its machine-readable
reason names the gate that refused it: `executor:exit_N`, `usage:<code>`, `delivery:<code>`,
`harness:<subtype>`, `verifier:<id>`, `auxiliary:<code>`, `isolation:symlink_escape`,
`sentinel:public_request`, `sentinel:credential_exposure`. A malformed or incomplete record fails toward `invalid`, never
toward fewer tokens or a pass. An infrastructure-invalid attempt may be retried under the
preregistered rule; every paid retry stays in attempt history and in the cost appendix, and a
task failure gets no free retry unless the same rule applies to every arm.

## Manifest contract

`manifest.py` accepts exactly these keys and nothing else: `benchmark_version`,
`schema_version` (1), `harness`, `seed`, `repeats`, `pins`, `price_sheet_version`, `tasks`,
`arms`, and optionally `phases` with `producer`, `capture`, `consumer` labels. Pins are
`model`, `harness_version`, `effort`, `image`, `dependency_lock_hash`, `permission_mode`,
`wall_clock_s`, `turn_budget`. A task is `id`, `family`, `transfer_distance`, `fixture`,
`fixture_hash`, `verifier`; an arm is `id`, `executor`, `product_version`, `settings_hash`,
`memory_snapshot_hash`, `auxiliary_usage`.

`auxiliary_usage` is the arm's declaration about model spend outside the harness session:
`none` (it spends none), `exposed` (its memory product emits auxiliary receipts), or
`unexposed` (it spends tokens the benchmark cannot see). There is no default, because silence
about auxiliary spend is exactly the failure the field names, and the reducer keeps an
`unexposed` arm out of the headline.

Validation happens before any spend and rejects unknown keys, duplicate ids, ids that are not
opaque tokens, a fixture path that is absolute, escapes the manifest directory, or is missing,
a `fixture_hash` that does not equal `manifest.fixture_hash(dir)` (sorted relative paths plus
file digests), any version that is empty or a range (`latest`, `^`, `~`, `*`, `>`, `<`), hash
fields without a `sha256:` prefix, an `auxiliary_usage` outside those three values, and arms
that do not share one executor. Manifest values are
data: executor and verifier names select code-owned argv and nothing is shell-evaluated. The
manifest hash is the SHA-256 of the canonical JSON; `trial_id` derives from it plus task, arm,
repeat, and schedule position, so a rewrite changes every trial id.

## Trial and actor contract

An actor key is `(harness, root_session_id, native_actor_id)`; the lead has `''` and a child id
matches `[A-Za-z0-9_-]{1,128}` (the product's `AGENT_ID_RE`). An attempt record lists every
actor discovered under the root session. Each entry carries `parent_actor_key` and
`parent_provenance`; the key is null exactly when the provenance is `unavailable`. The Claude
adapter stores a `native` edge only from a structured field (`parent_tool_use_id` naming a
tool call another actor issued). Prose in tool results and transcript path layout never
produce an edge, and a child with no structured edge stays `unavailable` even when the root's
tool result names it.

## Usage contract

`usage.UsageRecord` is one logical model request: `adapter`, `adapter_version`, `trial_id`,
`actor_key`, `native_request_id`, `input_total`, `uncached_input?`, `cache_read?`,
`cache_write?`, `output_total`, `reasoning_output_subset?`, `provider_total?`,
`native_request_cost?`, `completion_state` (`complete` | `partial`), `source_hash`.

- Null means the provider did not expose the category. It is never written as zero, and
  `usage.totals` reports a category as null (with an `unavailable` count) when any record
  hides it rather than adding zero.
- Subset arithmetic is validated before normalizing: exposed input categories sum to
  `input_total`, `reasoning_output_subset` never exceeds `output_total`, `provider_total`
  never falls below input plus output.
- `usage.dedupe` keeps the first sighting of an identical `(actor, request)` pair (a root
  echo of a child row), fails on two records for one request that disagree, and fails on one
  request id claimed by two actors. Rows are never summed into a request.
- `usage.AuxiliaryReceipt` is the benchmark-owned receipt for a memory-product model call,
  keyed by trial, component, phase, and native request id. `usage.check_receipts` fails the
  attempt on any duplicate native id, across receipts or into the consumer set.
- Attempt-level cost (`cost_usd`, from Claude's envelope) is a reconciliation value and is
  never apportioned across requests; `native_request_cost` stays null for Claude.

## Claude adapter contract

`claude_usage.parse_session_dir(sessions, root_session_id, trial_id)` reads
`<root>.jsonl` and every `<root>/subagents/agent-<id>.jsonl`. The frozen row shapes are the
synthetic sessions under `fixtures/claude/sessions/`:

- An `assistant` row carries `message.id` and `message.usage` with `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, optional
  `output_tokens_details.thinking_tokens` (the reasoning subset), optional
  `cache_creation.ephemeral_*` detail (must sum to the cache-write category), and optional
  `usage.iterations` (the native retry shape). Rows with `model: "<synthetic>"` are not
  requests; any other assistant row without `usage` is rejected.
- Rows group by top-level `requestId`; `message.id` is the documented fallback. A message id
  seen under two keys, two message ids under one key, or one key across two actors is
  ambiguous and rejected.
- One record per group: the last row. Earlier rows must be prefixes of it (identical input
  categories, non-decreasing `output_tokens`) or the group is rejected as
  `input_disagreement` or `output_regressed`. `usage.iterations` entries must sum to the
  top-level usage (`iterations_mismatch` otherwise); the retry count is a diagnostic.
- `completion_state` is `complete` when any row in the group has a `stop_reason` or the
  transcript ends in a `result` envelope; a group cut off by a kill is `partial` and keeps its
  last observed counts.
- A row's actor is its `agentId` when present, else the file's actor. A row in the root file
  with `isSidechain` or `parent_tool_use_id` and no `agentId` is rejected
  (`sidechain_without_agent`); a child file whose rows name another agent is rejected
  (`actor_mismatch`). Root-forwarded child prose in tool results adds nothing; an echo of a
  child request in the root file with identical counts collapses to one record.
- The `result` envelope (`subtype`, `is_error`, `num_turns`, `total_cost_usd`, `usage`,
  `modelUsage`) must be the last row. `subtype` in `error_max_turns` or
  `error_max_budget_usd` marks the attempt `capped`.
- Reconciliation compares the selected root records with the envelope per category. Statuses:
  `matched` (root records alone), `matched_with_descendants` (envelope also counts child
  requests), `explained_by_side_models` (the remainder equals `modelUsage` for models that
  wrote no root row; kept as an attempt-level `unattributed` value, never apportioned),
  `mismatch` (the attempt is `invalid` with reason `usage:mismatch`), `no_envelope` (the root
  did not settle), `envelope_without_usage`. A category either side hides is skipped, not zeroed.
- Every rejection raises `ClaudeUsageError` with a stable `code` (`malformed_row`,
  `malformed_usage`, `duplicate_request`, `conflicting_records`, `rows_after_result`,
  `session_mismatch`, `tool_use_reused`, `ambiguous_parent`, and the codes above); the runner
  records `usage:<code>` as the invalid reason.

## Attempt record contract

`records.RECORD_SCHEMA` is `bench1.attempt.v1`. A record carries the manifest, schedule,
settings, and environment hashes; task, arm, repeat, position; harness and native root id;
actors and parent edges; deduplicated usage, the reconciliation, and auxiliary receipts;
outcome (`pass` | `fail` | `capped` | `interrupted` | `invalid`) with `invalid_reason` set
exactly for `invalid`; verifier verdict and patch hash; stop reason (`exit` | `timeout` |
`interrupted`), wall time, unresolved actors, turns, tool counts, cost; delivery projection;
sentinel counts and isolation checks; and hashes of private inputs, never their bodies or host
paths.

`records.validate` refuses unknown keys, a `trial_id` that does not derive from the record's
own fields, a scored attempt without the lead actor, usage or fires naming an actor outside
the attempt, undeduplicated or conflicting usage, receipts duplicating native ids, and a pass
or fail without a verifier verdict. It also carries the accounting invariant rather than
leaving it to the runner that wrote the file: a non-`invalid` outcome needs a
`usage_reconciliation` of `matched`, `matched_with_descendants`, or `explained_by_side_models`,
and only a `capped` or `interrupted` outcome may add `no_envelope`, because the cap itself
names the gap. `records.publish` writes a unique partial file, flushes
and fsyncs it, then hard-links the final path; a second writer for the same `trial_id` loses
and keeps its partial file as evidence. `records.select` returns final records matching the
current manifest and schedule hashes and excludes everything else with a reason: `partial`,
`stale`, `misnamed`, `duplicate`, `invalid`, `foreign`.

## Delivery join contract

`loop_join.project(loop_db, actors)` opens a stopped trial's `loop.db` with
`file:...?mode=ro&immutable=1` and refuses when a `loop.db-wal` file exists: settlement is not
complete and the main file alone would be missing frames. It never writes and creates no
`-wal`/`-shm` side files. Fires join on the exact `(harness, session, agent)`; a sibling with
another agent id never receives a fire, and no ancestry is inferred. Fires for actors outside
the native set are returned as `unmatched_fires`, which the runner treats as an attribution
error (`delivery:fire_without_usage`), never as a zero-token actor. A native actor with no
fire is normal. Projected fields are ids, timestamps, enums, and the `delivered` resource
token; `question`, `cwd`, `emit`, `error`, `title`, and `url` stay private.

## Reduction contract

`reduce.reduce(accepted, excluded, baseline, seed)` turns immutable records into aggregates.

- The numerator is consumer actor-set usage plus the consumer-phase auxiliary receipts the
  attempt caused. Failed, capped, and interrupted attempts keep every token they spent.
- Totals are taken per attempt and then added. A native request id is unique inside one attempt
  and repeats across attempts, so pooling first would let one attempt's request cancel another's.
- Invalid attempts are counted in `arms[*].outcomes` and listed in `invalid` with a reason code.
  They never enter a task cell.
- Every task weighs the same. A cell is one `(arm, task)` pair; an arm figure is the mean over
  its task cells, never a sum over attempts, so a task with more repeats or bigger prompts does
  not speak louder.
- Pass rate and token ratio are separate axes and nothing folds them into one number.
- `tokens_per_verified_resolution` is null with reason `no_verified_resolution` when a cell has
  no pass, and an arm figure is null when any of its tasks is.
- Injected text is already inside the consumer's input and the reasoning subset is already
  inside `output_total`. Both appear under `diagnostics` with `counted_in_tokens: false` and are
  never added to the total.
- Producer and capture phase receipts are one-time knowledge cost. They leave the per-attempt
  numerator, are counted once per native request id however many attempts record them, and come
  back through `amortization` at reuse 1, 2, 5, and 10.
- `comparisons[arm]` pairs each task against the baseline arm (the first arm in the manifest),
  reports the mean per-task ratio, and attaches a `task_paired_percentile` interval from
  `paired_bootstrap`: `random.Random(seed)`, 2000 resamples of the task set with replacement, a
  stated nearest-rank index, and floats rounded to 12 places so one frozen seed reproduces one
  interval. `fixtures/fake/bootstrap-golden.json` pins that output.
- An arm whose usage cannot be fully attributed (a reconciliation that is not `matched` or
  `matched_with_descendants`, or an actor that never settled outside a declared cap) is
  `accounting_incomplete` and `headline_eligible: false`. A declared cap is `partial_by_cap`,
  which stays eligible: the gap is named by the outcome itself.
- `reduce.reduce` takes the manifest's arm list as `declared_arms`. Records say what was
  observed; only the manifest can say what an arm was able to expose, so an arm declaring
  `auxiliary_usage: unexposed` is `incomplete` with reason `auxiliary_unexposed` and cannot
  enter the headline even when all of its records reconcile. The ratio is still computed and
  shown; it is the headline flag, not the arithmetic, that refuses to trust it.

## Private and publishable boundaries

Everything under a run directory is private: transcripts, worktrees, stores, model prose,
prompts, memory bodies, patches, executor stderr, and the disposable roots themselves. Records
carry hashes of those inputs, never their bodies or host paths. Retain raw artifacts encrypted
by benchmark version if they are retained at all.

`report.json` is the only publishable artifact. `report.project` copies named fields rather than
filtering a record, and `report.guard` then refuses the result as a unit. A publishable string
is a SHA-256 token or an opaque token of at most 64 characters from `[A-Za-z0-9_.:+-]`, so a
path separator, a space, a newline, or a quote is a refusal by construction and prose cannot be
spelled at all. On top of that the guard refuses known credential shapes and the benchmark's own
canary by value, and refuses a private-sounding key (`prompt`, `transcript`, `question`,
`memory`, `stderr`, `cwd`, `argv`, `home`, `url`, `title`, `private_hashes`, and the rest of
`report.FORBIDDEN_KEYS`) before reading its value. Each refusal carries a code: `host_path`,
`credential`, `not_opaque`, `private_field`, `unpublishable_type`.

## Fixtures

`fixtures/claude/sessions/` holds one synthetic session per case: `sess-root-only`,
`sess-family` (child, grandchild, two concurrent siblings, forwarded prose, sidechain echo),
`sess-flat` (child without a structured edge), `sess-retry` (`usage.iterations`),
`sess-categories`, `sess-null-zero`, `sess-fallback` (message-id keys), `sess-malformed`,
`sess-duplicate`, `sess-capped` (killed mid-request), `sess-capped-turns`, `sess-ambiguous`,
`sess-mismatch`, `sess-side-models`. The `loop.db` fixture is built at test time from the
product's own `LOOP_DDL` in `src/hooks/store.ts`. Real transcripts are never read.

`fixtures/fake/` holds the offline end-to-end data:

- `manifest.json` and `repo/`: the one-task, two-arm manifest `cli.py fake-run` drives.
- `corpus-manifest.json` and `corpus/`: a frozen attempt corpus of 12 immutable records over
  three tasks, two arms, and two repeats, including a `fail`, a `capped`, an `interrupted`, an
  `invalid`, consumer-phase and capture-phase auxiliary receipts, and joined delivery fires,
  plus a stale record, a partial file, and a foreign file for the exclusion path. Its
  `schedule.json` pins the expansion. The corpus is data, not a builder: a record or manifest
  change means editing the checked-in JSON, and `test_reduce.py` names every aggregate that
  depends on it.
- `bootstrap-golden.json`: frozen `paired_bootstrap` output for four seeded inputs.

## Extending the foundation

Bench-2, Bench-3, and Bench-6 add data and adapters, not architecture.

- A new task is a manifest entry plus a fixture directory and a verifier id. The fixture hash is
  `manifest.fixture_hash(dir)`; the verifier is a new `verifier.REGISTRY` entry with its own
  code-owned argv and hidden layer. No reducer or record change.
- A new arm is a manifest entry plus an `executor.REGISTRY` entry. Arms in one manifest share
  one executor, because arms running different harnesses do not have comparable token totals.
  A driver that installs a competing memory hook gets its own image, home, and data roots; never
  co-install two memory hooks in one profile.
- A new harness is one module implementing the usage adapter contract: return logical model
  requests as `usage.UsageRecord`, one per native request, with nulls for categories the
  provider does not expose. Add the harness id to `usage.HARNESSES`. Claude's JSONL reader is
  the first implementation of that contract, not the architecture.
- A memory product that spends model tokens of its own emits `usage.AuxiliaryReceipt` values
  keyed by trial, component, phase, and native request id. `runner.Runtime.receipts` is that
  seam: a `(trial_id, roots) -> list[AuxiliaryReceipt]` callable the operator supplies, whose
  result is checked against the consumer set and written into the record. A receipt naming
  another trial, or a native request id already claimed by another receipt or a consumer
  request, makes the attempt `invalid` with reason `auxiliary:<code>` and publishes no receipt
  at all. An arm that cannot expose its spend declares `auxiliary_usage: unexposed` and cannot
  enter a headline; do not estimate it from text length.
- Bench-3's team cases run with `team.publicFallback` on. The delivery projection records the
  origin and leg sequence; Bench-1 does not treat a public result as team transfer, and Bench-3
  reports any public fallback separately.

None of this changes the manifest schema, the record schema, the reducer, or the guard. A change
that does is a benchmark version bump, and a treatment-informed rewrite is always a new version.
