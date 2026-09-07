# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only,
stdlib Python only. This package measures trials: for one task and one quality bar, how many
model tokens did the complete agent run consume with and without a knowledge system. It does
not itself produce a savings number, and nothing here touches the product runtime.

Plan: `tenjin-notes/plans/2026-09-04-benchmark-foundation.md`. The contract sections below are
frozen by the accounting commit group; the operator sections (live command, isolation
attestation, reducer intervals) land with the execution and reduction groups.

## Layout

```
evals/benchmark/
  manifest.py      frozen manifest: load, validate, hash; fixture directory hash
  schedule.py      balanced, seeded schedule; trial_id and schedule SHA-256
  records.py       immutable attempt record: partial write, flush, publish without overwrite
  usage.py         UsageRecord and AuxiliaryReceipt contracts, arithmetic, null-vs-zero, dedupe, totals
  claude_usage.py  Claude JSONL usage adapter (group by requestId, select one row, reconcile)
  loop_join.py     read-only projection of a stopped trial's loop.db onto exact actor keys
  runner.py        executes a schedule: fresh roots, settlement, timeout, resume
  executor.py      executor registry (code-owned argv, shell=False) and the fake executor
  verifier.py      hidden verifier registry and the fake verifier
  artifact.py      disposable trial roots and the post-shutdown verifier copy
  reduce.py        failure-inclusive task-equal reducer
  report.py        publishable projection and its redaction guard
  cli.py           fake-run | reduce | report
  selftest.py      offline unittest entry (what src/evals-benchmark.test.ts runs)
  tests/           unittest modules, one per contract
  fixtures/fake/   the fake manifest and fake repo
  fixtures/claude/ sanitized synthetic Claude JSONL sessions (no real transcript)
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

## Manifest contract

`manifest.py` accepts exactly these keys and nothing else: `benchmark_version`,
`schema_version` (1), `harness`, `seed`, `repeats`, `pins`, `price_sheet_version`, `tasks`,
`arms`, and optionally `phases` with `producer`, `capture`, `consumer` labels. Pins are
`model`, `harness_version`, `effort`, `image`, `dependency_lock_hash`, `permission_mode`,
`wall_clock_s`, `turn_budget`. A task is `id`, `family`, `transfer_distance`, `fixture`,
`fixture_hash`, `verifier`; an arm is `id`, `executor`, `product_version`, `settings_hash`,
`memory_snapshot_hash`.

Validation happens before any spend and rejects unknown keys, duplicate ids, ids that are not
opaque tokens, a fixture path that is absolute, escapes the manifest directory, or is missing,
a `fixture_hash` that does not equal `manifest.fixture_hash(dir)` (sorted relative paths plus
file digests), any version that is empty or a range (`latest`, `^`, `~`, `*`, `>`, `<`), hash
fields without a `sha256:` prefix, and arms that do not share one executor. Manifest values are
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
`interrupted`), wall time, turns, tool counts, cost; delivery projection; sentinel and isolation
checks; and hashes of private inputs, never their bodies or host paths.

`records.validate` refuses unknown keys, a `trial_id` that does not derive from the record's
own fields, a scored attempt without the lead actor, usage or fires naming an actor outside
the attempt, undeduplicated or conflicting usage, receipts duplicating native ids, and a pass
or fail without a verifier verdict. `records.publish` writes a unique partial file, flushes
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

## Fixtures

`fixtures/claude/sessions/` holds one synthetic session per case: `sess-root-only`,
`sess-family` (child, grandchild, two concurrent siblings, forwarded prose, sidechain echo),
`sess-flat` (child without a structured edge), `sess-retry` (`usage.iterations`),
`sess-categories`, `sess-null-zero`, `sess-fallback` (message-id keys), `sess-malformed`,
`sess-duplicate`, `sess-capped` (killed mid-request), `sess-capped-turns`, `sess-ambiguous`,
`sess-mismatch`, `sess-side-models`. The `loop.db` fixture is built at test time from the
product's own `LOOP_DDL` in `src/hooks/store.ts`. Real transcripts are never read.
