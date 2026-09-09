# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only,
stdlib Python only. This package measures trials: for one task and one quality bar, how many
model tokens did the complete agent run consume with and without a knowledge system. It does not
itself produce a savings number, and nothing here touches the product runtime.

**What this layer owns.** Bench-1 owns the frozen contracts, the executor and the live executor,
the provisioning seam and daemon lifecycle, isolation, attestation and sentinels, the reducer,
the report and its headline rule, `verify`, `cases` and `regress`, and one fake plumbing smoke
that needs no repository. Bench-2 (PR 313) owns every real fixture as a container image, every
real-task manifest including the hooks and keys smokes, the four arms, the producer phase, and
the readouts. The real-repository fixtures under `fixtures/live/` sit on this side of that line
only until the first image-backed fixture is green.

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

| Module                      | What it owns                                                      | Held by                               |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `manifest.py`               | frozen manifest: load, validate, hash, fixture hash over the tree | `test_manifest.py`                    |
| `schedule.py`               | balanced seeded schedule, `trial_id`, schedule SHA-256            | `test_schedule.py`                    |
| `runner.py`                 | execution: fresh roots, settlement, caps, sentinels, resume       | `test_runner.py`, `test_fake_run.py`  |
| `executor.py`               | executor registry (code-owned argv, `shell=False`), fake agents   | `test_artifact.py`                    |
| `claude_live.py`            | the live executor: argv, minted session id, per-trial settings    | `test_claude_live.py`                 |
| `tenjin_arm.py`             | the hooks arm: seeded data dir, keyed lesson, one daemon a trial  | `test_tenjin_arm.py`                  |
| `signature.py`              | the product's `sig_v1` and `sig_v1_test` keys, ported             | `test_signature.py`                   |
| `artifact.py`               | disposable roots, sentinels, the isolation attestation            | `test_artifact.py`                    |
| `verifier.py`               | hidden verifier registry, hidden layer, the run marker            | `test_verifier.py`                    |
| `vendor.py`, `toolchain.py` | the vendored archive and the trial's pinned, offline pnpm         | `test_vendor.py`, `test_toolchain.py` |
| `usage.py`                  | usage and receipt arithmetic, null-vs-zero, dedupe                | `test_usage.py`                       |
| `claude_usage.py`           | the Claude JSONL adapter and its reconciliation                   | `test_claude_usage.py`                |
| `records.py`                | the immutable attempt record, publish, select                     | `test_records.py`                     |
| `loop_join.py`              | read-only delivery join on exact actor keys                       | `test_loop_join.py`                   |
| `reduce.py`                 | task-equal reduction, amortization, seeded bootstrap              | `test_reduce.py`                      |
| `report.py`, `regress.py`   | publishable projection, redaction guard, regression warnings      | `test_report.py`, `test_regress.py`   |
| `cases.py`, `discovery.py`  | the search-intent export and the discovery counters               | `test_cases.py`, `test_discovery.py`  |
| `reap.py`                   | cleanup by recorded identity, never by process name               | `test_reap.py`                        |
| `cli.py`, `selftest.py`     | the commands, and the offline entry the required lane runs        | `test_fake_run.py`                    |

The data beside them: `fixtures/fake/` (the manifest and repo `fake-run` drives, and the
bootstrap golden), `fixtures/live/` (the smoke manifests, the frozen Vitest task fixture and its
vendored archive, the seeded lessons, the regression baseline), `fixtures/claude/` (sanitized
synthetic Claude sessions; no real transcript), and `hidden/` (code-owned hidden layers, one per
task, mounted only into the verifier's copy).

## Its CI lanes

The offline suite is a step of the required `CI` workflow, on every pull request with no path
filter: the interpreter floor, `python3 evals/benchmark/selftest.py`, then the fake manifest
driven to a published report, the hidden verifiers re-run over it, and `summary` printed to the
run page. It installs nothing (standard library on the runner's own `python3`, floor 3.11, and a
runner below the floor fails rather than skips, because a skipped gate reads like a passing one),
takes about 20 seconds, and the step's own timeout bounds it.

The live plumbing smoke is `benchmark-live.yml`, on a pull request touching `evals/benchmark/**`
and on dispatch: a pinned Claude Code, `live-run --plumbing --ci-live` over the smoke manifest
with `CLAUDE_CODE_OAUTH_TOKEN` on that one step, then `verify`, `summary`, `regress`, `cleanup`,
and `report.json` uploaded alone. Every record is stamped automated and non-publishable, so the
lane is evidence that the chain runs on a real agent and never a number anyone may quote. It is
informational: not required, never blocking, and not `continue-on-error` either, because a red
run is meant to be seen; on a fork the secret is absent and the live steps skip.

## The fake command

```bash
python3 -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python3 -m evals.benchmark.cli verify --run /tmp/bench1-fake
python3 -m evals.benchmark.cli summary --run /tmp/bench1-fake
python3 evals/benchmark/selftest.py
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

Everything under `--out` except `report.json` is private. The report carries counts, enums,
opaque ids, and hashes only, plus the run's isolation stamp: `publishable`, `isolation` (`fake`,
`attested`, `operator_plumbing`, `automated_plumbing`, or `team_shelf_secret`), and
`shelf_secret_present`. One non-publishable record makes the whole report non-publishable and no
comparison in it headline eligible, and `summary` says so in its header.

## The operator-only live command

`claude_live` is the only executor in the registry that starts a real agent, and `live-run` is
the only command that reaches it. The two commands refuse each other's manifests, so neither path
can quietly run the other's executor.

```bash
# what it would run. No process starts, nothing is spent.
python3 -m evals.benchmark.cli live-run --manifest <live manifest> --out ~/bench1-live --dry-run

# the real run, operator side only, inside the disposable instance
python3 -m evals.benchmark.cli live-run --manifest <live manifest> --out ~/bench1-live \
  --attestation ~/bench1-attestation.json
```

`--dry-run` builds each trial's roots and its argv exactly as `runner.run_trial` would, prints
the roots, the names (never the values) in the child environment, and one copyable argv line,
then stops before the spawn. It is how a reviewer reads the real command without paying for it,
and the only live-path behavior an automated environment reaches without `--ci-live`.

```text
claude -p '<the task prompt>' --output-format stream-json --verbose --include-hook-events
  --model <pins.model> --max-budget-usd 0.50 --strict-mcp-config
  --setting-sources project --settings <run>/trials/<trial_id>/settings.json
  --tools Read,Edit,Write,Glob,Grep
  --allowedTools 'Read(./**)' 'Edit(./**)' 'Write(./**)' 'Glob(./**)' 'Grep(./**)'
  --permission-mode dontAsk --session-id <uuid5 of the trial id>
```

Every flag there is a literal in `claude_live.py`; the manifest supplies values only, and each is
checked against a declared allowlist before it becomes an argument (a model id shaped like a
flag, a tool outside the declared set, an allowed-tool rule carrying a shell fragment, a budget
above the ceiling, a prompt that is not a plain string, and an undeclared settings key are all
refused). Nothing is quoted or escaped, because none of it reaches a shell: `process_spawn` runs
the list with `shell=False`.

Five properties of a live trial carry the isolation, and `claude_live.py` states each one where
it is enforced. The session id is minted rather than read back (`uuid5` of the trial id), so a
resumed schedule names the same session. Session persistence stays on, because a child agent's
usage exists only in the persisted transcripts: a trial sets `CLAUDE_CONFIG_DIR` to its profile
root and `CLAUDE_CODE_PROJECT_DIR_NAME`, so the tree is at `<profile>/projects/<root session>/`
in the layout the fake path also writes and the usage adapter is unchanged. The arm is a settings
file, checked to the leaf (`env` may not name a variable the trial's roots or the credential seam
own, `permissions` may narrow the flag pins but never widen them, an `http` hook may name only
loopback) and hashed against the arm's declared `settings_hash`, which proves the fragment is the
treatment the record names and proves nothing about whether it is safe; a provisioned arm's
fragment is a template, so the declared hash is over the template and the resolved fragment's
hash is private, because the resolved bytes hold the daemon token. A hook `command` is
operator-authored code the child runs through a shell, which is what a hooks arm is for, so the
manifest hash and the `settings_hash` name which commands ran and the attested container is what
contains them; a task fixture may not carry a `.claude` directory, which would be a settings
channel no record names. And the child environment is an allowlist: the trial's own `HOME`,
`CLAUDE_CONFIG_DIR`, `TENJIN_DATA_DIR`, and `CLAUDE_CODE_PROJECT_DIR_NAME` plus inherited `PATH`,
`TERM`, `LANG`, and the one named credential variable, so a wallet key, a shelf secret, and the
operator's own config have no way through, by the spawn or by `settings.env`.

Without `--dry-run` the command requires `--attestation` (or `--plumbing`), refuses an automated
environment unless `--ci-live` is given, and refuses a shell without `pins.credential_env` set,
on top of the refusals `artifact.require_isolation` owns: a live executor in CI that is not
automated plumbing, a publishable live run with no attestation, an automated run claiming to be
publishable or attested, and an attestation whose `credential_seam` is not the variable the run
passes. `--ci-live` is valid only with `--plumbing`, never with `--attestation`, and stamps
`isolation.automated: true` into every record, so a CI run can never be published.

### The attestation, and what the operator prepares

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
owns; no wallet in the image or the environment, and no shelf secret except the one
`--tenjin-source` seeds on purpose; the model credential in exactly one allowlisted variable
named by `pins.credential_env`; network allowlisted to the provider plus the arm under test,
matching the attestation; and `pins.image`, `pins.harness_version`, and `pins.model` set to what
this instance actually runs. Project-scoped tool permissions and transcript redaction are
retention controls, not an operating-system sandbox, and a temp directory does not isolate a
keychain (tenjin-agent#71).

### The smoke manifests

`fixtures/live/smoke-manifest.json` is a plumbing smoke, not a task set: one trivial task under
the fixed hidden verifier, two arms differing by a marker in their settings, two repeats. Gate 3
of the plan is four to eight live attempts of it, and what they prove is plumbing (disposable
isolation, recursive settlement, usage capture from real transcripts, verifier execution after
shutdown, the sentinels), never a savings claim; `fixtures/live/baseline.json` holds the last
operator run's per-arm figures and the 25% tolerance `regress` warns against. The two
real-repository smokes, `hooks-smoke-manifest.json` and `keys-smoke-manifest.json`, one per
delivery path, move to Bench-2 with the container images; an operator runs them with `live-run
--manifest <manifest> --out <dir> --plumbing --tenjin-source <tenjin data dir>`, and neither ever
runs in CI, a refusal that lives in code rather than in the workflow.

## The Tenjin hooks arm

The product's hooks are not an environment difference: the CLI reads
`<TENJIN_DATA_DIR>/config.json` and nothing else for `baseUrl`, `publicShelfUrl`, and
`shelfBypassSecret`, the `command` hooks run the shim bundle under that directory, the `http`
hooks POST to a loopback daemon that reads `daemon.token` from it, and the daemon ignores the
environment. So the arm is a seeded data dir plus a daemon, and `tenjin_arm.py` builds one per
trial from the operator's own data dir, which `--tenjin-source` names and which has no default.
`tests/test_tenjin_arm.py` holds the seam; four of its rules are worth stating here.

**Provisioning and stop.** An arm declaring `provision: "tenjin"` is prepared after its roots
exist and before its launch: the bundles are copied, exactly `COPIED_KEYS` are copied from the
source config, the constants in `SEEDED` are forced, a fresh `daemon.token` and a free loopback
port are minted, and one daemon starts under `process_start` in its own session with its group in
the pids ledger. `prepare` waits for `/health` to name this data dir and this pid and refuses the
trial otherwise; nothing wallet-related is copied. `stop` ends the daemon once the agent has
exited and waits for `loop.db-wal` to disappear, and because the shim may have spawned a detached
daemon outside the trial's group it also reads `daemon.pid` as it is then, confirms through
`/health` that it serves exactly this data dir, and signals it too
(`isolation.daemon_respawned`). A live WAL after the wait is `delivery:wal_live` and the attempt
is invalid; a refused prepare invalidates its own trial under `provision:<code>`, undoes what it
half-did, and leaves the rest of the run alone.

**Seeding is honest only if a lesson reached the shelf the way a producer's would**: published
through the CLI, under the failure key the consumer's failure fire resolves on. `prepare` freezes
each lesson's keys from its `.json`, re-derives them by running the fixture's failing commands in
a scratch copy under the child's own environment, keys each output with `signature.py` (the
product's formula ported byte for byte and held to the TypeScript by
`src/hooks/failure/signature.parity.test.ts`), refuses the trial on `seed key drift`, and
publishes each body with `--key fingerprint=<kind>:<key>` under the source data dir, whose wallet
signs it, with a per-run nonce because the CLI dedups a body it already published. At `stop`
every piece is deleted, and `isolation.seed` records each lesson's title, key hashes, origin,
piece id, probe, and deletion result.

**The shelf secret is a canary.** `shelfBypassSecret` is copied because the team leg is an
unsigned POST carrying it as a header, so every record says so: `isolation.shelf_secret_present`
true, `publishable` false, `report.isolation` `team_shelf_secret`, and `summary` printing `team
shelf secret present: NOT PUBLISHABLE`. `require_isolation` refuses a publishable run that seeds
a secret, `records.validate` a record claiming both, `--attestation` a source carrying one, and
`--ci-live` any manifest with a provisioned arm. `scan_sentinels` counts the value in the repo,
the output, the data dir except the seeded config, and the profile.

**Origins are classed, and discovery is counted rather than forbidden.** The seeded config names
the team shelf and the public marketplace, both join the origins the attestation must list, and
every delivery leg is classed by its `shelf` column as `team`, `public` (a fallback leg, and a
`keys` leg, which the public host also serves), `local` (never leaves the process), or `other`.
Only `other` reaches the sentinel's `public_requests` and invalidates, so the plan's canary gate
is two counts judged on their own: unknown requests zero and public hits zero. A task's expected
values live in the hidden layer and reach the trial's repository copy at launch, derived and
outside every `fixture_hash`; an agent that reads them anyway is counted by
`discovery.setup_read` and `discovery.test_run_before_fix`, which `summary` prints per arm. A
seeded arm may also read the shelf by hand through arm-level `settings.permissions.allow`, and
`loop_join` reports those as `delivery.cli_searches`, apart from the hooks' own fires.

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

`fixtures/live/` holds the operator-side manifests, `repo/` for the plumbing smoke, one frozen
Vitest project per task, the seeded lessons (arm-side data, never copied into a trial), and the
regression baseline. Frozen means no run artefacts, and `manifest.fixture_hash` covers every
committed file plus the vendor archive's digest; hidden layers live in
`hidden/<task>/hidden-tests/` as plain Node assert files.

A trial's `node_modules` is derived, never committed. `fixtures/live/vendor/` holds one
deterministic archive per toolchain and platform with a record beside it (`archive_sha256`,
`tree_sha256`, `files`, `platform`, `node_abi`, `vitest`, `lock_sha256`, `pnpm`), and
`artifact.create` extracts it into the trial's fixture copy offline, checking the archive against
its record and the host against the platform pin, then the extracted tree against `tree_sha256`.
`live-run` refuses a manifest whose vendor was built for another platform or node ABI before any
root exists; CI never extracts it, because the offline suite packs a tiny archive of its own.
**This whole path is the darwin pin Bench-2 replaces with a container image per task**: when the
first image-backed fixture is green, `vendor.py`, the archive, the lockfiles, the corepack
seeding, and the actor fixture leave this package with the two real-repository smokes.

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
estimated from text length. `cli.py cases` exports the labelled search-intent records the
teammate's plan asks for (`tenjin-notes` `loop-redesign/14-search-intent.md`) after settlement,
masked and post-floor, and changes no record.

None of this changes the manifest schema, the record schema, the reducer, or the guard. A change
that does is a benchmark version bump, and a treatment-informed rewrite is always a new version.
