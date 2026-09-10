# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only.
Every shipped command is standard-library Python; the offline suite is the one part that
installs anything, and it installs exactly pytest. This package measures trials: for one task and
one quality bar, how many model tokens did the complete agent run consume with and without a
knowledge system. It does not itself produce a savings number, and nothing here touches the
product runtime.

**What this layer owns.** Bench-1 owns the frozen contracts, the executor and the live executor,
the provisioning seam and daemon lifecycle, isolation, attestation, the corpus reset and
sentinels, the reducer,
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

| Module                     | What it owns                                                             | Held by                              |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `manifest.py`              | frozen manifest: load, validate, hash, fixture hash over the tree        | `test_manifest.py`                   |
| `presets.py`               | named arm settings, expanded at load, an inline block over them          | `test_presets.py`                    |
| `schedule.py`              | balanced seeded schedule, `trial_id`, schedule SHA-256                   | `test_schedule.py`                   |
| `runner.py`                | execution: fresh roots, settlement, caps, sentinels, resume, concurrency | `test_runner.py`, `test_fake_run.py` |
| `executor.py`              | executor registry (code-owned argv, `shell=False`), fake agents          | `test_artifact.py`                   |
| `claude_live.py`           | the live executor: argv, minted session id, per-trial settings           | `test_claude_live.py`                |
| `tenjin_arm.py`            | the hooks arm: seeded data dir, keyed lesson, one daemon a trial         | `test_tenjin_arm.py`                 |
| `signature.py`             | the product's `sig_v1` and `sig_v1_test` keys, ported                    | `test_signature.py`                  |
| `artifact.py`              | disposable roots, sentinels, the isolation attestation                   | `test_artifact.py`                   |
| `corpus.py`                | the corpus branch: the pre-run reset, its guard, its stamp               | `test_corpus.py`                     |
| `verifier.py`              | hidden verifier registry, hidden layer, the run marker                   | `test_verifier.py`                   |
| `images.py`                | one pinned base image, one image per fixture, build and drift            | `test_images.py`                     |
| `container.py`             | a trial inside its image: mounts, argv, the run's egress proxy           | `test_container.py`                  |
| `producer.py`              | the natural arm's producer phase and its receipts                        | `test_phases.py`                     |
| `usage.py`                 | usage and receipt arithmetic, null-vs-zero, dedupe                       | `test_usage.py`                      |
| `claude_usage.py`          | the Claude JSONL adapter and its reconciliation                          | `test_claude_usage.py`               |
| `records.py`               | the immutable attempt record, publish, select                            | `test_records.py`                    |
| `loop_join.py`             | read-only delivery join on exact actor keys                              | `test_loop_join.py`                  |
| `reduce.py`                | task-equal reduction, amortization, seeded bootstrap                     | `test_reduce.py`                     |
| `report.py`, `regress.py`  | publishable projection, redaction guard, the check-run summary           | `test_report.py`, `test_regress.py`  |
| `cases.py`, `discovery.py` | the search-intent export and the discovery counters                      | `test_cases.py`, `test_discovery.py` |
| `reap.py`                  | cleanup by recorded identity, never by process name                      | `test_reap.py`                       |
| `snapshot.py`              | the per-run corpus reading: post count and content hash                  | `test_snapshot.py`                   |
| `cli.py`, `selftest.py`    | the commands, and the offline entry the required lane runs               | `test_fake_run.py`                   |

An arm's treatment is its `settings`, and most arms run the same one, so an arm may name a preset
instead: `"settings_preset": "tenjin-hooks-and-cli-reads"` is the product's whole hook wiring plus
permission to run the CLI's read verbs by hand, defined once in `presets.py`. An arm may still
inline a block, and one written beside a preset wins key by key, which is where a real difference
between two arms stays visible in the manifest rather than folded into a preset. `manifest.load`
expands the name before it validates and before it hashes, so the hash stays over the settings
that actually run: the seven committed manifests hash today exactly what they hashed with the
block inlined, and the schema `validate` enforces is unchanged, which is why this is shorthand
rather than a benchmark version bump.

The data beside them: `fixtures/fake/` (the manifest and repo `fake-run` drives, and the
bootstrap golden), `fixtures/live/` (the smoke and real-task manifests, one frozen Vitest project
per task, the seeded lessons, the regression baseline), `fixtures/claude/` (sanitized
synthetic Claude sessions; no real transcript), and `hidden/` (code-owned hidden layers, one per
task, mounted only into the verifier's copy).

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

The live plumbing smoke is `benchmark-live.yml`, on a pull request touching `evals/benchmark/**`
and on dispatch: a pinned Claude Code, `live-run --plumbing --ci-live` over the smoke manifest
with `CLAUDE_CODE_OAUTH_TOKEN` on that one step, then `verify`, `summary`, `regress`, `cleanup`,
and `report.json` uploaded alone. Every record is stamped automated and non-publishable, so the
lane is evidence that the chain runs on a real agent and never a number anyone may quote. It is
informational: not required, never blocking, and not `continue-on-error` either, because a red
run is meant to be seen; on a fork the secret is absent and the live steps skip.

### The two measured lanes

Two lanes run measured attempts against the bench shelf, on a schedule and on manual dispatch,
never on push: each run spends model budget, and a per-push trigger would spend it on every
review round. `benchmark-canary.yml` runs the canary manifest nightly, 24 attempts, about 5.69
USD. `benchmark-headline.yml` runs the core suite weekly and on a published release, and its
number is the one meant to be quoted. Both call `benchmark-shelf.yml`, which holds every step,
so a canary and a headline can never drift into measuring different things two ways.

They share one concurrency group and a queued run waits rather than cancelling a paid one,
because the reset is destructive and the bench branch is one branch: two runs at once would empty
the corpus under each other and neither number would mean anything. Each needs three repository
secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `NEON_API_KEY`, `TENJIN_BENCH_WALLET`), and a lane missing
one skips and says so on the run page rather than publishing a check run for a run that measured
nothing.

Each publishes its headline, its intervals and a link to this file as the `output.summary` of a
**check run** on the commit it ran from. That is the one surface a signed-out reader can reach:
measured on this public repository with no token, the artifact bytes answer 401, the artifact
route 404 and the job logs 403, while `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`
answers 200 with its whole `output`. `output.summary` caps at 65,535 characters, which
`report.check_summary` enforces and says when it has; `cli.py headline` prints exactly what the
workflow posts. The per-attempt records stay a workflow artifact, for whoever is logged in and
wants to recompute. The conclusion is `success` when the run is publishable with a
headline-eligible comparison, `neutral` when it produced a number nobody may quote, and
`failure` when it produced no report at all; the lanes are not required checks and block nothing.

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

## The live command and its two unwatched lanes

`claude_live` is the only executor in the registry that starts a real agent, and `live-run` is
the only command that reaches it. The two commands refuse each other's manifests, so neither path
can quietly run the other's executor.

```bash
# what it would run. No process starts, nothing is spent.
python3 -m evals.benchmark.cli live-run --manifest <live manifest> --out ~/bench1-live --dry-run

# the real run, inside the disposable instance
python3 -m evals.benchmark.cli live-run --manifest <live manifest> --out ~/bench1-live \
  --attestation ~/bench1-attestation.json

# the same run on a schedule: an automated environment, still attested
python3 -m evals.benchmark.cli live-run --manifest <live manifest> --out ./bench1-run \
  --attestation ./attestation.json --automated
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
environment unless `--ci-live` or `--automated` is given, and refuses a shell without
`pins.credential_env` set, on top of the refusals `artifact.require_isolation` owns: a live run
in CI that is not stamped automated, a publishable live run with no attestation, a run that seeds
a team shelf secret and claims to be publishable, and an attestation whose `credential_seam` is
not the variable the run passes.

Publishability follows the attestation and not the launcher. Who started a run is a fact about
the run rather than a claim about its isolation, so `isolation.automated: true` is stamped in
every record of both unwatched lanes and bars nothing by itself; a machine-built attestation over
the container, the network and the egress a run created is a stronger claim than a person's word
that a laptop was quiet. The two lanes stay separate commands: `--ci-live` is valid only with
`--plumbing`, never with `--attestation`, and never with a provisioned arm, which keeps it the
unattested smoke it has always been; `--automated` requires `--attestation`, refuses `--plumbing`,
and is the lane a scheduled measured run uses.

### The corpus a run measures

A manifest may name a `corpus`: `provider` (`neon`), `project_id`, `branch_id`, `parent_id`, and
the `origin` that database serves. `live-run` then resets that branch from its parent before the
first trial, so the corpus a run measures is the one it seeded rather than whatever else reached
the shelf since. A reset that does not happen ends the run there; `fake-run` refuses such a
manifest outright, because the offline lane touches no database.

The reset is destructive and it runs inside the project holding the team's knowledge, so
`corpus.guard` reads the branch the provider returns, never the manifest's claim, and refuses a
default branch, a protected branch, a branch whose id is not the one the manifest names, and a
branch whose parent is not the parent the manifest names. `corpus.Api` is the seam: two calls, an
`HttpApi` against Neon, and a fake in every test, so the guard is testable before the branches
exist. `HttpApi` waits for the restore's operations, because a started reset is not a finished
one.

What was reset is then a machine-built field of the attestation (`artifact.CorpusStamp`: the
provider, the project, the branch, its parent, the origin, the control-plane host, and the reset
time). An operator cannot write it into the attestation file, which refuses unknown keys; it
reaches every record through `isolation.corpus` and the attestation hash, and the report carries
it, so a reader sees which corpus a number came from. Both of its origins join the ones the
network allowlist must name.

The stamp says which branch was emptied and when. What was standing on it afterwards is the
run's own reading (`snapshot.py`): once the first trial's seed has reached the shelf, the run
walks the deployment's public discovery feed and records a post count and a content hash over a
fixed projection of every listed piece, in id order. Page order and the read counts the feed
folds on cannot move that hash. It is taken once, whatever a run's later trials seed and delete,
because a run has one corpus and a per-trial reading would be a different fact. A reading that
fails is a recorded refusal and not an ended run: the reset is the gate that protects the
measurement, and this is the readout beside it. `report.corpus_snapshot` carries the count, the
hash, the origin and the time, and `summary` and the check run say when there is no reading at
all, because a report that cannot name its corpus should say so rather than look complete.

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
the shelf the run measures and the public marketplace, both join the origins the attestation must
list, and every delivery leg is classed by its `shelf` column as `team`, `public` (a fallback leg,
and a `keys` leg, which the public host also serves), `local` (never leaves the process), or
`other`. An arm with `public_fallback: "off"` still lists the marketplace as an allowed origin and
simply never reaches it, so `public_legs` at zero is a measurement rather than a blocked request.
Only `other` reaches the sentinel's `public_requests` and invalidates, so the plan's canary gate
is two counts judged on their own: unknown requests zero and public hits zero. A task's expected
values live in the hidden layer and reach the trial's repository copy at launch, derived and
outside every `fixture_hash`; an agent that reads them anyway is counted by
`discovery.setup_read` and `discovery.test_run_before_fix`, which `summary` prints per arm. A
seeded arm may also read the shelf by hand through arm-level `settings.permissions.allow`, and
`loop_join` reports those as `delivery.cli_searches`, apart from the hooks' own fires.

### A public leg says it is a benchmark

A measured leg reaching the marketplace is not somebody asking a question, and the field that
separates the two is the User-Agent. `live-run` mints the run nonce, arms
`TENJIN_CALLER_USER_AGENT=tenjin-eval/bench1-<nonce>` in its own environment before it starts the
egress, and refuses the run if that value does not lead with `tenjin-eval`. Every tenjin process
the run starts then inherits it: the seeding publish, sweep, search and delete through
`cli_environment`; the trial container through `container_environment`; the agent, its Bash
`tenjin` and the shim because the entrypoint spawns the agent with no environment of its own; and
the trial's daemon, plus any daemon the shim respawns, through `FORWARDED` in `docker/trial.mjs`.
`claude_live.launch` refuses an attempt that has an egress and no such value, because the failure
it prevents is silent: the run succeeds, its numbers are right, and only the marketplace's demand
tables show the damage. `benchmark-shelf.yml` arms the same value, keyed on the workflow run and
attempt, for the one CI step that runs the CLI outside `live-run`.

The product name is what the demand gates read (`notProbe` in tenjin `lib/search/gates.ts`, off
`lib/search/client-names.ts`); the version half is this benchmark and the run, because the server
keeps a leading product's name and version in separate columns and holds 32 characters of the
version, which `bench1-<nonce>` fills exactly. So a row names the run that produced it without
any product change.

**Two product gaps keep this from being the whole fix, and neither is fixable here.** First, the
documented handoff composes BEHIND the CLI's own identity: `composeUserAgent` in
`src/lib/client-meta.ts` returns `tenjin-cli/<version> tenjin-eval/bench1-<nonce>
(+https://tenjin.blog)`, and the server attributes on the FIRST product, so `client_name` is
`tenjin-cli` and `notProbe` does not drop the row. Run against the shipped bundle to check, not
inferred. Today the field therefore IDENTIFIES a benchmark row in the 90-day raw sink and does not
yet exclude it from demand; closing that needs an environment-settable leading product in the CLI,
whose `product` option has no call site outside its own module. Second, `daemonEnv` in
`src/hooks/shim.ts` is an explicit allowlist that carries neither this field nor
`NODE_USE_ENV_PROXY` nor `TENJIN_NO_UPDATE_CHECK`, so a daemon the shim respawns inside a trial
(`isolation.daemon_respawned`) is unnamed and unproxied whatever this package sets.

### What the runs before this contributed, and why it is left alone

Measured off the run directories on this machine and the public marketplace's own endpoints. No
database was read.

**Volume.** 95 public-marketplace legs across every local run whose records survive here
(`records/*.json`, `delivery.legs[].shelf == "public"`): 48 in the 96-attempt `bench2-arms` run, 23
in `bench2-pilot`, 2 in each of the eight container runs, 4 in an aborted run, and 2 each in the
two smoke runs. Only the eight container runs have a proxy log, and it holds 6 `tenjin.blog`
tunnels, 4 allowed and 2 refused. Two CI canary runs on 2026-09-09 ran the seeded arm against a
config naming the marketplace as its public shelf and sent legs of their own; their proxy logs are
not retained, so those are counted from the workflow rather than from a log.

**Per term, which is the half that decides it.** The hook's public leg is `POST /api/search`
carrying `question: cut(text, 512)`, which the server records as a `decision` view with
`capture: "always"`, so the text is stored as `lookups.generalized_query` and the rows join the
QUESTION tier population rather than the term tiers. The one query string any run artifact still
holds is `shortlist.json`'s question, byte identical to the `actor` task's prompt; twelve distinct
prompts exist across the live manifests, ten of them of the form `Fix src/<file> so that
tests/<file> passes. Run only that one test file...`, and they run 93 to 232 characters, so every
one of them clears the question tiers' 256-character display cap and none would clear the terms' 80. On such a term we are effectively 100 percent of its rows, and the question tiers carry no
distinct-requester floor, so neither length nor volume excludes them. Three
things bound it instead: `QUESTIONS_MAX_PER_REQUESTER` is 2 of a 50-row page and every local leg
shares one egress hash, `QUESTIONS_WINDOW_DAYS` is 7 so an entry ages off on its own, and
publication waits on a cached judge verdict that fails closed behind a 24-hour delay.

**Checked rather than assumed.** On 2026-09-09 `GET https://tenjin.blog/api/trending` returned
empty `top` and `unmet`, and the rendered `/trending` page carried both question sections and other
publishers' questions but none of the fixture substrings (`spawn subagents`, `so that tests`,
`tests/actor`, `answer.txt`, `@fixture/range`, each of the `src/*.mjs` names). That is the display
surface and it is cached, not the stored rows.

**The permanent aggregate is the one place a retraction could not reach.** `demand_daily` applies
`notProbe` at INSERT and recomputes only a trailing 7 days with no backfill, so a day outside that
window keeps the counts it recorded and no display-time exclusion changes them. It carries counts
by dimension tuple with no query text, and nothing reads it today.

**Verdict: acceptable as noise, because it stops.** No fixture prompt is on the page, the surface
expires its own entries in seven days, and the permanent residue is a per-day count with no text
and no reader. The number that would flip this is one fixture prompt visible on `/trending`, since
we would be all of it; that is worth re-checking against the stored rows if the question ever
matters more than it does here. It is acceptable only on the condition above: without the identity
this section arms, every future run re-adds rows under the same single hash and re-arms the same
seven-day window.

## Bench-2: local reuse

Bench-2 measures the product's LOCAL reuse path with no shelf deployment: a lesson one session
learned on this machine, delivered to a later session on the same data dir. Plan:
`tenjin-notes/plans/2026-09-04-developer-token-savings-benchmark.md`, Bench-2 row and Phase 1.
Nothing in this section runs in CI; every manifest here is an operator command.

This section and its fixtures are pull request 313; the foundation under it is 308. The two
merge together and split by ownership rather than by coverage, which **Fixtures are container
images** states in full: 308 owns the contracts, the executor, the provisioning seam, the
reducer and the report; 313 owns every real fixture, every real-task manifest, the arms, the
producer phase, and the readouts.

**Where the plan's wording and the product differ.** The plan and the directive that shaped
this section speak of a Stop-hook capture with `hooks.capture` on and `publish.mode` auto
becoming a local lesson, and of a stale lesson gated by `valid_until`. The product on `main`
(`21ce314`) is not built that way, and this package measures the product as built:

- Local reuse is the failure arm's `pairings` table (`src/hooks/failure/pairings.ts`). A
  failing command opens a row keyed on the signature lanes (`sig_v1`, `sig_v1_test`); the same
  agent's later pass on the SAME command, after editing a tracked file, closes it
  (`unverified`; a second independent session's agreeing close makes it `verified`); a later
  failure under the same key in the same project (`projectId`, a hash of the cwd string) is
  answered by the row on the `local` leg as "Someone once fixed this by touching: <files>. It
  passed afterwards on: <command>". Nothing else writes those rows: no CLI verb, no daemon
  route, no config.
- The Stop-hook capture (`src/hooks/capture.ts`) harvests a `finding:` fact and feeds the
  publish ask (`tenjin publish --finding`); it never feeds the `local` leg. Its gate is
  `hooks.publish`; `hooks.capture` does not exist, and `publish.mode` changes only the words of
  the ask (`auto` tells the lead to publish rather than asking). A trial's data dir carries no
  wallet, so a producer cannot publish to any shelf from a trial; nothing is left to delete.
- Nothing local expires: `pairings` has no `valid_until`, `findPairing` has no time term, and
  retention (`src/daemon/retention.ts`) prunes `fires`, `marks`, and unclaimed `handoff` only.
- A lesson whose fix is a DIFFERENT command (the test-harness convention: `node tests/x`
  fails, `pnpm exec vitest run` passes) has no local record in the product, because a pairing
  closes only on a pass with the same command head.
- The seeded-LOCAL arm is retired. Bench-2 first defined `tenjin_seeded` as the trial's own
  store pre-populated through the daemon (the five hook events of a fix replayed with the
  probe's real failure output, so the product wrote its own `pairings` row), with the stale
  and scale slices built on it. The operator retired it on 2026-09-08: tenjin-agent#326's
  proposed resolution removes local pairing replay and automatic closure, so an arm built on
  closed pairings measures a mechanism that is going away, and the arm's consistency check
  ("the store holds 2 closed pairings, the seed replayed 1") aborted the four-arm run at trial
  11 of 96. `tenjin_seeded` is now the shelf-seeded arm exactly as the foundation's hooks
  smoke runs it, below; the local-seed code, its distractor corpus, and the scale and stale
  manifests are gone with it (the stale slice had been a refusal anyway: nothing local expires).

**The four arms** (`local-arms-manifest.json`):

- `off`: empty settings, as before.
- `flat`: the same approved lessons as static Markdown in the repository, through the
  foundation's `settings.overlay`: one `LESSONS.md` holding every lesson below (all thirteen
  bodies from `fixtures/live/lessons/`, verbatim, in a fixed order; a test holds the overlay
  to the lesson files) and a `CLAUDE.md` that tells the agent to read it. The overlay is
  hashed into `settings_hash`, written into the repository copy at launch, and never enters
  the child's settings file. No hooks, no daemon.
- `tenjin_seeded`: the shelf-seeded arm exactly as the foundation's hooks smoke runs it (**The
  seeded lessons** above): the task's family lesson and its fix (or the arm's `lessons` list)
  published through `tenjin publish --key` under the run nonce at `prepare`, deleted at
  `stop`, the shelf-read permissions allowed, the same hook template and daemon as the
  natural arm's consumer. It measures Tenjin's retrieval, delivery, and use of an approved
  lesson through the shelf, with capture variance excluded; local pairing replay is retired
  (above). This arm is Tenjin **with the publish nudge disabled**: its seeded config sets
  `hooks.publish` false, which is a configuration a user can choose with `tenjin hooks disable
publish`, and the record says so in `isolation.hooks_disabled`. The reason is the operator's
  ruling of 2026-09-09 (tenjin-agent#316), and it is a product rule as much as a benchmark
  one: the nudge belongs off wherever capture is off, and a consumption arm captures nothing,
  so the turn it costs buys nothing here. Every other hook arm the product ships stays on. The
  pilot of 2026-09-08 measured this arm with the nudge on, and its records remain the
  shipped-default comparison.
- `tenjin_natural`: `producer: true`. Capture is this arm's subject, so it keeps every hook arm
  the product ships on, the publish nudge included, and `hooks_disabled` is refused on an arm
  that runs a producer phase. A producer session runs first (`producer.py`): its own
  home, profile, output, transcripts, and canary, the same pins, the same repository path
  (the product scopes local records by cwd hash), the same data dir, the daemon on the
  `producer` config (`publish.mode` auto). When it exits the daemon is stopped and its WAL has
  to be gone (`producer:wal_live` otherwise); the settled store is read once (closed
  pairings, harvested findings, the producer's fires, its first `turn.end`); the producer's
  worktree goes through the task's hidden verifier, and a producer that did not pass makes
  the attempt invalid `producer:failed` with no consumer started; then the repository is
  re-copied fresh at the same path, the daemon restarts on the consumer config with the same
  token on a fresh port (`isolation.producer.daemon: restarted`), and the consumer runs. The
  producer's usage is written as auxiliary receipts (`component: producer`): phase `producer`
  for requests before its first turn-end fire (the work the task would have cost anyway) and
  phase `capture` from that fire on (what the capture ask added). The consumer's own usage is
  never mixed with either. `isolation.producer` carries the producer's outcome, verifier,
  stop reason, wall time, turns, cost, token totals, actor count, reconciliation status, the
  phase split, the store facts, and its sentinel counts; `delivery.phase_fires` counts the
  producer's (and the seed replay's) fires apart from the consumer's, and `delivery.failure_key`
  is the consumer's alone.

**The eight tasks**, each a Vitest project in its own image with a hidden
Node verifier and hidden test cases (`hidden/<task>/`, see **Discovery** above; nothing
committed under a fixture holds an expected value), a goal-shaped prompt with no lesson vocabulary, and a
family lesson plus a fix lesson in this benchmark's words, keyed by the product formula and
re-probed every trial (drift is a refusal). Discovery cost is what the `off` arm pays without
the lesson, stated from the command matrix run by hand on trial copies:

| Task                                   | Family                    | Real failure, reproduced on a trial copy                                                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                             | Discovery without the lesson                                                                                                                 |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor`, `budget`, `candidate`, `slug` | `test-harness-convention` | the package `test` script runs every project, the runner refuses any non-pnpm entry, plain `node` cannot run a vitest file; the assertion prints the value                                                                                                                                                                                                     | one line in `src/<task>.mjs`                                                                                                                    | three to five commands, each failing for a repository reason, then one green run                                                             |
| `alias`                                | `vitest-path-alias`       | `tsconfig.json` maps `@/*`; Vitest resolves through Vite and never reads `paths`: `Error: Cannot find package '@/window.mjs' imported from 'tests/alias.test.ts'`; once resolved, `lastWindow(values, 0)` returns the whole list (`slice(-0)`)                                                                                                                 | `resolve.alias` in `vitest.config.mjs`, then one line in `src/window.mjs`                                                                       | one run, a read of the config and the tsconfig, the Vite alias fact, then a second run that prints the case                                  |
| `level`                                | `node-type-stripping`     | the test spawns `node src/cli.ts`; Node 24 strips types and refuses `enum`: `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`                                                                                                                                                                             | a `const` object and a derived type, same `Level` name                                                                                          | one run (the child's stderr is in the assertion), the erasable-syntax rule                                                                   |
| `money`                                | `esm-cjs-interop`         | the test spawns `node src/cli.mjs`; a CommonJS module written the way TypeScript emits it (`exports.__esModule`, `exports.default`) arrives in ESM as the exports object: `TypeError: formatMoney is not a function`, no interop named                                                                                                                         | read `.default` in `src/cli.mjs`                                                                                                                | one run, then the CJS default-import rule, which the message does not state; Vitest itself unwraps it, so the in-runner import path misleads |
| `core`                                 | `pnpm-workspace`          | a pnpm workspace whose tests live in `packages/core`: `pnpm test` at the root has no script, `pnpm -r test` runs every package's whole suite, a root-scoped `vitest run packages/core/...` finds no config so the package's setup file and reporters never run (`No test suite found`, the marker never written); the package-scoped assertion prints the rule | one line in `packages/core/src/core.mjs`, run from the package (`pnpm --filter core exec vitest run tests/core.test.mjs` or `-C packages/core`) | three or four commands, the workspace and config-discovery facts                                                                             |

Keys the product derives, verified twice on fresh trial copies: `level` keys on both lanes
(`sig_v1` off Node's error line in the assertion message, `sig_v1_test` off the FAIL header);
`money` keys on both, and `node src/cli.mjs` alone keys the same `sig_v1`; `core` keys on
`sig_v1_test` from the package-scoped run only (the root-scoped run collects no suite and keys
nothing under either lane); `alias`
keys on nothing under either lane (a suite-level import failure: no errno, the frame line ends
the block, no test ran), so the product cannot capture or answer it locally, which is a
hook-stage miss the funnel is meant to show, and `alias-fix` keys only once the alias is
resolved (`check: false`, derived on a fixed copy). `transfer_distance` is `same_family` for the
Bench-0 family (its convention lesson is shared by four consumers) and `same_task` for the four
new families, each of which has one consumer; no family here has a near and a far consumer, so
the plan's near/far split waits for Bench-3's history-derived pairs. `lessons/` also holds
`actor-fix-keyonly` for the foundation's keys smoke. The new fixtures carry no trap, guard, or
shards: their one real failure is the family's.

**The high-discovery pilot** (`high-discovery-manifest.json`, `bench2-high-discovery-1`): two
tasks added to the corpus, replacing nothing. Plan: `tenjin-notes`
`plans/2026-09-10-high-discovery-tasks.md`. The 2026-09-09 CI run measured `off` at 7.50 model
requests an attempt and `tenjin_seeded` at 6.83, a `request_ratio` of 0.927 against a headline of
0.969, with `new_token_ratio` 1.471: the seeded arm sent 47% more genuinely new tokens and still
came out ahead, because it went back to the model fewer times. A lesson pays when it removes a
round trip, and a corpus whose worst task is four commands has almost none to remove. These two
put round trips in.

| Task      | Family                          | What is hidden                                                                                                                    | The only green path                                                    |
| --------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `shadow`  | `stale-build-artifact`          | that the test imports `packages/range`'s committed `dist/range.js`, so an edit to its `src` is silently a no-op                   | edit the source, `node scripts/build.mjs`, run the one file            |
| `ambient` | `invisible-whitespace-mismatch` | one byte: the expected values are `Intl` output whose group separator is U+00A0, where a hand-written implementation types U+0020 | emit U+00A0, through `Intl` or as an explicit escape, run the one file |

Both fail by assertion diff and never by a thrown error, which is the rule these shapes are built
on: a stack frame names the file that actually ran and would hand over the hidden fact at hop one.
Measured on the pinned Vitest 3.2.4 inside the image. `shadow` prints `expected '7-7' to be '7'`
with a code frame naming only `tests/shadow.test.mjs` and no path to the module that resolved, and
an edit to `packages/range/src/range.mjs` changes nothing the next run prints but its
milliseconds. `ambient` prints `expected '12 345,67' to be '12 345,67'`, two sides that are
byte-identical on screen; the printer escapes U+202F and U+FEFF and prints U+00A0, U+2009 and
U+200B raw, and of the raw ones U+00A0 is the only one that is a property of the runtime rather
than a character planted in a file, which one `cat -A` would find.

Two rules beyond the corpus's own three. **No task's difficulty may live in a behaviour that plain
`node` and Vitest disagree about**, because `verifier.py` runs the hidden test under `node` while
the fixture runs under Vitest: the two resolve conditional `imports` maps differently, and a design
built on one would judge an agent wrong for something it could not observe. `shadow` hides behind a
committed artifact rather than a resolver for that reason, and both runners were measured resolving
`@fixture/range` to the same file. **The lesson names the mechanism, never the patch**: each of
these tasks seeds one lesson, its family's, with no `<task>-fix` beside it, because what the
fixture still gets wrong lives only in the injected cases and a fix lesson there would be the
answer rather than the way in.

`ambient` needs an honesty device the others do not, because its whole difficulty is one byte of
one library's output. `hidden/ambient/image-check.mjs` asserts against the image that `Intl` still
renders every frozen case and that no case carries U+0020, and `images build` refuses an image that
fails it (`image_quirk_absent`). ICU 72 moved several locales to U+202F and on this runtime
`fr-FR` already groups with U+202F, so this is a dated fact a base bump could delete in silence.
The injected setup file writes an expected value as the character rather than as an escape
(`claude_live.inject_cases`, `ensure_ascii=False`), so the anti-hardcoding device stays exactly
what it was for every ASCII task without becoming the leak for this one; reading it is still
counted by `discovery.setup_read`.

The caps are raised, and that is a correctness decision rather than a performance one. This harness
does not reject a capped attempt: it keeps the spend and scores the outcome, so a ceiling throws
away no correct work. What it does instead is truncate the token count of the arm doing the extra
work, which is the baseline, and push the measured ratio toward 1. Against tasks designed for 12 to
17 requests where the corpus measures 7.50, `wall_clock_s` is 1500, `turn_budget` 80 and
`max_budget_usd` 2.50; the code ceiling is 25.0, so the last is a manifest choice. Pre-registered
beside them: **an `off` attempt that ends `capped` takes its task's cell out of the headline, and
the caps are raised before the run is repeated**, which turns a silent censoring into a loud
refusal. `environment_hash` is the sha256 of `pins`, so this manifest is a different environment by
construction and its records never pool with the eight-task runs; a comparison across the two is a
comparison across environments and has to be labelled as one.

The four `test-harness-convention` tasks stay, and their role becomes control rather than corpus:
they are the low-discovery end of the range at three to five commands, and without them a result on
these two cannot be told apart from a change in the harness, the model or the caps. A task enters
this corpus only once its `off` arm measures at least 13 requests an attempt over three dry-run
attempts; below that it is not a high-discovery task, whatever its design says.

**The slices.** The scale slice (N distractor records beside the real one) and the stale slice
(an expired lesson the local leg must refuse) were built on the local seed and retired with it;
they return when the product holds a local record a seed can write and an expiry it can gate
on. One slice remains, its own manifest:

- `recursive-manifest.json`: `slice: {kind: recursive}`. One task (`actor`) whose prompt
  delegates the diagnosis to a subagent, with `Agent` in that task's own `tools` and
  `allowed_tools` (a task-level override the manifest allows only under this slice), under
  `off`, `tenjin_seeded`, and `tenjin_natural`, three repeats, nine attempts; the child's own
  `agent_id` delivery and its `seen:` mark are exercised, per-actor usage is recorded as the
  foundation already does, and the report's `child_tokens` and `actors` read the descendants
  apart.

**Metrics: the headline rule.** Pre-registered by the operator on 2026-09-08, before any
pilot number was read: the headline token ratio of every publishable comparison is the
capture-only amortized ratio at reuse 1 (`comparisons[arm].headline`, rule
`capture_only_amortized_reuse_1`), that is, every token the capture ask added to the producer's
session is charged to a single consumer and nothing of the producer's own work is, because that
work would have happened anyway (the plan's `amortized_tokens(k)` at k = 1). It is task-equal
like `token_ratio`: one ratio per shared task, (consumer tokens per attempt + that task's capture
tokens) over the baseline's, the mean as the figure and the task-paired bootstrap of the reuse-1
set as `headline_interval`; `headline_eligible` is that figure's, ANDed with the run's
`publishable` stamp. The consumer-only ratio (`token_ratio`, its own interval) is the secondary
line, labelled "capture-free (future: capture on an operator-run model)": it is what the product
would cost if capture ran on a model the operator pays for separately, and it is not the
headline today. The amortization that charges the whole producer phase too
(`amortized_token_ratio`) stays a diagnostic line, never a headline. Why this order: reuse 1 is
the worst honest case for a capture-based product, the one a single reuse has to beat, and
choosing it before the first number exists is what keeps the choice from being tuned to it.

**The reducer and the report.** Per arm: `phase_tokens` (`producer`, `capture`, once per native
request id; also per task cell), `amortization` (the foundation's, charging producer and capture
together) and `amortization_capture_only` (the capture's incremental cost alone), and
`producer` (phases run, passed, captured a closed record, findings harvested, invalid, WAL
live). Per comparison:
`headline`, `headline_rule`, `headline_interval`, `headline_eligible`, `token_ratio`
(consumer-only), `amortized_token_ratio`, and `amortized_capture_only_token_ratio` at reuse 1,
2, 5, 10 (task-equal). `summary` prints, per comparison, the headline line first with its label
and interval, then the capture-only reuse curve at 2/5/10, then the capture-free line, then the
producer's-own-work diagnostic. Per cell diagnostics: `local_legs`,
`local_hits`, `child_tokens`, `child_requests`, `actors`. The report carries `slice`, and each
trial row `producer_outcome`, `producer_tokens`, `local_hits`, `child_tokens`; `summary` prints
the slice, one producer line per arm, and the local legs and descendant
tokens. The regress baseline is untouched: nothing
here has run, so nothing here has a baseline.

**The manifests, and how a run is pointed at the bench shelf.** Every real-task manifest names
the bench corpus and so runs against `bench.tenjin.sh`, which is a deployment of the same app on
its own Neon branch, reset from an emptied parent before the first trial. Runs no longer use the
shared team shelf, and a run that publishes to it is a refusal rather than a footnote.

**One knob points a run, and it is the one that used to point it wrong.**
`tenjin_arm.load_source` reads `baseUrl` from the directory `--tenjin-source` names, and that one
value drives both the runner's own CLI calls (the seeding publish, the stamped sweep, the in-run
shortlist, the delete) and the config injected into every trial. Pointing it at the operator's own
`~/.tenjin` is what sent every earlier run to the team shelf. So a run points it at a bench data
dir instead: a `config.json` holding `baseUrl` `https://bench.tenjin.sh`, `publicShelfUrl`
`https://tenjin.blog`, **no** `shelfBypassSecret` (the bench deployment is on a custom domain and
is exempt from the account's `all_except_custom_domains` protection, so it has none), the wallet
that publishes, and the three bundles `tenjin daemon start` writes. `live-run` refuses a source
whose shelf is not the one the manifest's corpus serves, so the old mistake is now a stop rather
than a number.

| Manifest                       | Version                   | Shape                                                                                     | Attempts        |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `canary-manifest.json`         | `bench2-canary-1`         | the four same-task transfers, one per lesson family, `off` and `tenjin_seeded`, 3 repeats | 24              |
| `local-arms-manifest.json`     | `bench2-core-suite-2`     | the core suite: 10 tasks x 5 arms x 3 repeats, caps raised                                | 150 + producers |
| `real-manifest.json`           | `bench2-local-pilot-3`    | the Phase 1 pilot: 8 tasks x (`off`, `tenjin_natural`) x 3                                | 48 + producers  |
| `recursive-manifest.json`      | `bench2-recursive-5`      | the recursive slice: one delegating task across four arms                                 | 12 + producers  |
| `high-discovery-manifest.json` | `bench2-high-discovery-1` | the pilot: `shadow` and `ambient`, `off` and `tenjin_seeded`, 3 repeats, caps raised      | 12              |

`max_budget_usd` stays 0.75 an attempt on the eight-task manifests, producer attempts included.
At the 0.237 USD an attempt the pilot measured, the canary is about 5.69 USD a run. The core suite
carries `shadow` and `ambient` and so takes the high-discovery caps with them: a ceiling sized for
7.5 requests would censor the quantity those two exist to move, and the other eight never approach
either ceiling. That raise is why the core suite and the canary no longer share an environment
hash, and their records never pool.

```bash
# the nightly lane's manifest, by hand
python3 -m evals.benchmark.cli attest --manifest evals/benchmark/fixtures/live/canary-manifest.json \
  --tenjin-source <bench data dir> --instance <what this instance is called> --image <what it booted from> \
  --out <dir>/attestation.json
python3 -m evals.benchmark.cli live-run --manifest evals/benchmark/fixtures/live/canary-manifest.json \
  --out <dir> --attestation <dir>/attestation.json --tenjin-source <bench data dir>
# after any run
python3 -m evals.benchmark.cli verify --run <dir>
python3 -m evals.benchmark.cli summary --run <dir>
```

`attest` derives the network allowlist from the manifest and the source rather than letting an
operator or a workflow retype it: the executor's required origins, the shelf and the marketplace
the source names, and the two origins the corpus reset itself reaches. It refuses a source
carrying a shelf secret and a source naming another shelf, before a file exists.

**The two shelf arms.** `tenjin_seeded` runs the product as shipped, so a team miss then reaches
the public marketplace. `tenjin_seeded_no_public` is the same arm with `public_fallback: "off"`,
which is the product's `team.publicFallback` and the exact string `src/hooks/ask.ts` reads to drop
the public-only legs. The reason it is an arm rather than a footnote: the bench shelf is reset and
snapshotted per run, so its corpus is exactly what the run seeded, while the public marketplace is
the real one and moves underneath a measurement. Reporting public hits apart is honest; running
without them is what tells a reader how much of an effect is the shelf and how much is the
marketplace. The two arms' Claude settings are byte-identical and so is their `settings_hash`, so
`isolation.public_fallback` is what tells them apart in a record, and `summary` names the arm that
ran with the leg off. An arm that says nothing gets `"on"`, so every manifest written before this
key behaves as it always did.

**Pilot 1 readout** (`bench2-local-pilot-1`, 2026-09-08, the operator's machine,
`--plumbing --tenjin-source`, so `team_shelf_secret`: NOT PUBLISHABLE, plumbing plus the first
pilot, and no number here is a result). 48 of 48 attempts pass, 0 invalid, `verify` agrees.
Producers: 24 of 24 pass, mean 107k tokens of their own work and 17k of capture ask per
producer (2,576,266 and 413,701 in all). Discovery, both arms alike: 12 of 24 ran the test
before the fix, 18 of 24 read the injected setup file. Delivery: 8 prompt-fire team-shelf hits,
all on `level`, `money`, and `alias`, from pre-existing shelf content (which piece, the
orchestrator is identifying); local legs 9, hits 0; keys legs 0 hits; 32 public legs, 0 hits.

| Task        | off tokens per attempt, mean | natural over off |
| ----------- | ---------------------------: | ---------------: |
| `actor`     |                      100,721 |             0.87 |
| `budget`    |                      116,308 |             0.81 |
| `candidate` |                       94,675 |             0.97 |
| `slug`      |                       99,193 |             0.97 |
| `level`     |                      101,527 |             1.15 |
| `alias`     |                       99,710 |             1.23 |
| `core`      |                       83,108 |             1.33 |
| `money`     |                      130,115 |             1.41 |

Consumer-only ratio (the capture-free line): 1.092, interval [0.949, 1.225] at 95% over 8
tasks. Amortized per lesson, task-equal (the corrected rule, below): headline, capture only at
reuse 1, 1.260 [1.101, 1.407]; reuse 2/5/10 1.176/1.126/1.109; the producer's own work charged
too, reuse 1/10, 2.298/1.213. The first `summary` of this run printed 5.104 / 30.075 for the
amortized lines: `amortize` was handed the arm-wide capture sum (413,701 over 24 producers) and
divided it by reuse alone, charging every producer's capture to one consumer. The rule is per
lesson: each task's consumer tokens plus that task's mean per-producer capture over `reuse`,
against the baseline's, then task-equal weighting like everything else (`reduce.task_cost`,
`amortize_tasks`); the report in the pilot's run directory was regenerated with `reduce`, `report`,
and `summary` on the untouched records.

Why the local path delivered nothing, from the 24 natural ledgers (`fires`, `pairings`,
`pairing_closes`, `marks`, read with `mode=ro&immutable=1`) and the producer transcripts:

- The data dir was shared as designed: every ledger holds exactly two sessions, the producer's
  and the consumer's, and the consumer's failure fires ran a `local` leg on that store.
- 14 of 24 producers opened no pairing at all: they edited the source before any test run (12
  of the 24 never ran a failing test; two more ran a command whose output keyed nothing), so the
  failure arm never fired with a key and there was no row for a consumer to find.
- 10 producers opened a pairing (8 `sig_v1_test` from a vitest assertion, 4 `sig_v1` where
  Node's error line carried a frame). A green run of the same command head followed the edit in
  all 10 (`vitest` or `pnpm`), but only 3 pairings closed, all `sig_v1` rows on `level` whose
  error block named `src/level.ts`: the close rule's file branch matched the edited basename.
  The `sig_v1_test` rows name only the test file (`error_files: ["actor.test.mjs"]`), so that
  branch fails, and the other branch needs the passing command to equal the failing one byte for
  byte; the producers re-ran the same head with a different pipe (`... 2>&1 | tail -60` to fail,
  `... 2>&1 | tail -40` to pass; `| head -100` to `| tail -40`), so `sameCommand` was false and
  the row stayed `open`, which `findPairing` never returns. That is the whole of the 0 hits:
  in the 4 trials where the consumer's raw failure key equalled the producer's pairing key
  (`actor` 4baf, `candidate` f1de, `money` 6028 and 741a) the consumer's fire is `no-hit` on
  an `open` row; in the other keyed trials the keys differ across lanes because each agent's
  `| head`/`| tail` kept a different part of the output (a `sig_v1_test` on one case number
  versus another, or a `sig_v1` with Node's frame versus none), which is the same finding from
  the other side.

Product finding, for the operator to file: in `src/hooks/failure/pairings.ts`, `closeOpenPairings`
closes a pairing only when `named` (an edited basename among `error_files`) or `sameCommand`
(`pairing.cmd === mask(passed)`) holds. Under Claude Code an agent almost never re-runs a
command byte-identically (it changes the `| head`/`| tail` it appends), and a vitest assertion's
`error_files` is the test file, never the source, so a fix that edits the source and re-runs the
same head with any other pipe leaves the row `open` for good; `findPairing` (same file) reads
`unverified` and `verified` only. In this pilot 7 of the 10 opened rows stayed open that way.
A close that matches on the command head plus the file argument, or on the pairing's own key
recurring green, would have closed them. Filing is the operator's call; nothing was filed.

`--dry-run` on each prints, per trial, the phases line for a producer arm, one `seed` line per
lesson for a seeded arm, the `overlay` files for `flat`, and the `slice`, and starts nothing.
Only the pilot has run (**Pilot 1 readout** above); the first four-arm run aborted at trial 11
on the retired local seed's consistency check and restarts from a fresh run directory under
`bench2-local-arms-2`.

## Fixtures are container images

A live trial runs inside its task's own image. That replaced a vendored darwin toolchain
archive, a committed lockfile per fixture, and a corepack seeding step, which together made
reproducibility a property of this repository's bytes on one machine (operator directive of
2026-09-08, after the review of the foundation at `11c64f4`).

**Images.** One base image, `bench2-base:<recipe hash>`, from `node:24-bookworm-slim` pinned by
its multi-architecture index digest
(`node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`, Node 24.20),
with `pnpm@11.11.0` and `@anthropic-ai/claude-code` at the manifest's `pins.harness_version`
installed globally by exact version, the Tenjin CLI this checkout builds, and the `bench2-trial`
entrypoint. One image per fixture, `bench2-<task>:<fixture hash prefix>`, built from
`docker/fixture.Dockerfile` with the fixture directory as its whole build context: the fixture
is copied to `/opt/fixture` and `pnpm install` runs there at build time, so the fixture commits
a `package.json` with `vitest` pinned and nothing else of the toolchain. There is one fixture
Dockerfile rather than eight identical ones; the per-task difference is the context and the
labels. Reproducibility is the image, not the lockfile: `python3 -m evals.benchmark.images
build --manifest <path>` builds every image a manifest names, labels each with the fixture
hash, the base image id and the pins it was built from, and writes the ids to
`fixtures/live/images.json`, a local build ledger that is not committed. `live-run` refuses a
trial whose image is missing (`image_missing`, naming the build command) or whose labels
disagree with the manifest (`image_drift`), and the record carries the image id, the CLI build
hash and the CLI commit under `isolation.image`. Because the install happens at build time, two
builds of one fixture on two machines may differ in a transitive dependency: the record names the build that ran, and a
locked run builds once and keeps the image. The base image is 710 MB and a fixture image 774
MB; a first base build is about 33s and each fixture about 20s, or 2 minutes for all eight.

**The CLI under test is this checkout's build.** The `tenjin` an agent runs in a Bash tool is
built from the repository the run checks out, not from a published release, so a CLI regression
reddens the lane instead of passing under a frozen pin. `images.cli_build` reads `package.json`
and every path its `files` names, `images.stage_cli` copies exactly those into the base build
context, and the Dockerfile runs `npm pack` plus `npm install -g` there, which is what a user
would install and so fails the build if `files` ever stops shipping the product. The build then
proves `tenjin daemon --help` answers, where the reason is legible rather than inside a paid
trial.

Identity is content, not a version string. `tenjin-cli@0.1.0-alpha.15` on npm carries no
`daemon` command anywhere in its dist while the repository at that same version string has it
(measured 2026-09-09; a CI lane installing the release failed with `unknown command 'daemon'`),
so the version identifies nothing. The recipe carries `tenjin_cli`, the sha256 of the staged
package's contents, which puts the CLI in the base tag and in every fixture image's
`bench2.recipe` label: a CLI change is a new tag, and a stale image can never be mistaken for
it. The checkout's commit rides beside it as the `bench2.cli_commit` label and reaches the
attempt record as `isolation.image.cli.commit`, with the content hash as
`isolation.image.cli.build`; `records.validate` refuses a record whose image carries neither.
The commit is deliberately not an image input, because a commit that leaves the packed package
byte-identical is not a new image, and `images.UNCOMPARED` keeps it out of the drift check for
the same reason. The environment hash does NOT cover any of this: it is the sha256 of the
manifest's pins alone, so `isolation.image` is where a reader resolves the build back to source.
There is no published-CLI pin left in the package; `TENJIN_VERSION` is gone rather than kept as
a pin nothing reads.

**A task may declare a runtime quirk, and the build proves the image still has it.** A fixture's
own bytes are covered by `fixture_hash`; a behaviour of the runtime under it is not, so a task
whose difficulty rests on one (`ambient`) states it as `hidden/<task>/image-check.mjs`, and
`images.quirk_check` runs that file inside the image it just built, read-only and off the network.
A check that fails is `image_quirk_absent` and the build stops there, which is the only place a
base bump that turned a hard task into a trivial one would be visible. The check is code-owned and
lives in the hidden layer, so a fixture cannot supply one and an agent never sees it.

**The installed tree is staged from the fixture root, not lifted out of `node_modules`.** A
workspace fixture's tree links out of `node_modules` into the package it links (`@fixture/range ->
../../packages/range`), and `docker cp` refuses to write a link that leaves the directory it is
copying: measured 2026-09-09 as `invalid symlink`, with the whole export failing. Copying
`/opt/fixture` instead resolves that link inside the copy, and only `node_modules` is moved on, so
a trial's fixture files stay the ones the runner copied. The staging directory sits inside the
repository copy, so the move is a rename rather than a second traversal of 780 files.

**A trial runs inside the container.** The trial's roots are built on the host as before and
bind-mounted at the SAME absolute paths: the repository copy, `HOME`, the profile
(`CLAUDE_CONFIG_DIR`), `TENJIN_DATA_DIR`, the output root the entrypoint writes its daemon
report to, and the arm's settings file read-only, because `--settings` names a path outside
every other root. Same paths, because the product hashes the working directory into its local
records, the hook template resolves `{data_dir}` to an absolute path, and the transcripts
Claude writes under the profile are read back by the host. `node_modules` is copied out of the
fixture image into the trial's repository copy at preparation (`docker create` plus `docker
cp`, 788 files in under a second); it is the image's tree, Linux natives included, and the host
never runs it. The `claude` binary comes from the image by exact version and the `tenjin` CLI
from the image as this checkout's build; the daemon, shim and reporter bundles come from the
seeded data dir, which is a mount, because they are platform-neutral JavaScript. Both are now
one build of the product: the data dir is materialised by a `tenjin daemon start` running the
same `dist/` the image packs (`.github/workflows/benchmark-shelf.yml`). The container
runs as the host's uid and gid, so a file it writes stays the host's. The credential seam is
forwarded by name (`docker run --env CLAUDE_CODE_OAUTH_TOKEN`), so its value travels through
the docker client's own environment and appears in no argv, no file and no image layer. The
daemon runs inside the container on the same data dir: the entrypoint (`docker/trial.mjs`)
starts it, waits for `/health`, runs `claude` with the argv the runner built, stops the daemon
and any daemon the shim respawned, waits for the WAL to vanish, writes `daemon.json` into the
output root, and exits with claude's code; the host reads that file instead of signalling a
pid, and `tenjin_arm` no longer starts a process at all. The natural arm's two phases are two
containers in sequence on one data dir. The container name goes into the run's process ledger,
so `cli.py cleanup`, the wall-clock cap and an interrupt all stop and remove it.

**Network.** Per run the runner creates one Docker network with `--internal` (no route out and
no DNS for an outside name: resolution fails with `EAI_AGAIN`, proven on this machine's colima
29.5.2) and one egress proxy container on both that network and the default bridge: a Python
`CONNECT` proxy from `python:3.12-slim` pinned by index digest, holding the run's allowlist and
logging every request with its verdict to `<run>/proxy/requests.jsonl`. The run waits until the
proxy is accepting connections before any trial starts, because a CONNECT into a container with
no listener stalls on an internal network rather than being refused. Every trial container
joins the internal network only and gets `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY=127.0.0.1,
localhost` and `NODE_USE_ENV_PROXY=1` (Node 24 reads the proxy variables for `fetch` under that
flag), so Claude Code, the daemon's shelf legs and the CLI's reads all go through the proxy and
nothing else can leave. The allowlist is `api.anthropic.com` plus the seeded config's team and
public shelf hosts; a request to any other host is refused with 403 and counted as that trial's
`sentinel.public_requests` through `container.ProxySentinel`, which reads the log the runner
already counts deltas on. The proxy does not log a request from its own loopback, because the
readiness check is not a request a trial made.

Proven on 2026-09-09, on the base image with the run's own egress: `fetch` to
`https://api.anthropic.com/v1/models` returned 401 (the provider answered; the log line says
`verdict: allowed`), `fetch` to `https://example.com/` failed and the log line says `verdict:
refused, reason: not on the allowlist`, and the same fetch with no proxy variables failed with
`EAI_AGAIN`. So the allowlist is enforced by construction, and a live run carries an
attestation the runner writes itself (`kind: container`, the run's network as the instance,
the base image by digest, `fresh_roots: true`, `wallet_present: false`, the seam, the
allowlist). What colima cannot enforce, and the record does not claim: nothing at the packet
level inside the container beyond "no route out" (a process there can still talk to the proxy,
which is the point), and nothing about the host side of a bind mount.

**Where the plan and the code differ.** Three places, each because the machine said so:

- The plan said the four roots are mounted; the code mounts six. The output root and the
  settings file are the two the process cannot run without.
- The plan put the base image at the tag `bench2-base`; the tag carries the recipe hash, so a
  changed pin can never reuse a stale base.
- The plan said nothing about where a run directory may live. On colima the Docker daemon is a
  Linux VM that shares only part of the host filesystem, and a run directory outside that set
  mounts as an empty directory: a trial would find no repository. `live-run` writes a marker
  into the run directory and reads it back from a container before anything is spent, and
  refuses with `mount_invisible` naming the fix (a run directory under your home).

The offline paths lost nothing to any of this: the fake path and the self-test never touch
Docker, every docker call is a seam a case replaces, and `live-run` checks `docker info` first
and refuses in one sentence when the daemon is not reachable.

**What went.** `vendor.py`, the archive and its record and rebuild script, `toolchain.py` and
the per-trial corepack home, the `.bin/vitest` shims, the lockfiles, the `.npmrc` files and the
`packageManager` pins, with their tests and README sections, and the runner's helper-process
seam, which existed only for the host daemon. The darwin-native path was not kept behind a
flag: the four-arm run in flight executes from its own checkout, its records are immutable and
reduce on their own manifest, and nothing here rewrites them.

**Dry runs** print the image tag, the container name, the uid, the mount plan (host path to
container path, mode), the container's environment names, the forwarded seam, the network plan
(internal network, proxy image, allowlist), the daemon line for a provisioned arm, and the
agent's own argv, and start nothing. The manifests carry the new fixture hashes.

**This section and PR 308.** The two pull requests merge together and split by ownership, not
by coverage. 308 owns the frozen contracts, the executor and the live executor, the
provisioning seam and the daemon lifecycle, isolation, attestation and sentinels, the reducer,
the report and its headline rule, verify, cases and regress, plus one plumbing smoke that needs
no repository. 313 owns every real fixture as a container image, every real-task manifest
including the hooks and keys smokes, the four arms, the producer phase and the readouts; with
the container fixtures green it also takes the `actor` fixture and the hooks-smoke and
keys-smoke manifests, so 308's follow-up deletion leaves it with the plumbing smoke alone.

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

`fixtures/live/` holds the operator-side manifests, `repo/` for the plumbing smoke, one frozen
Vitest project per task, the seeded lessons (arm-side data, never copied into a trial), and the
regression baseline. Frozen means no run artefacts, and `manifest.fixture_hash` covers every
committed file; hidden layers live in `hidden/<task>/hidden-tests/` as plain Node assert files.

A trial's `node_modules` is derived, never committed: the task's image owns the installed tree,
so no lockfile, no `.npmrc`, and no `node_modules` enter a fixture directory. `fixture_hash` is
also the image's tag and one of its labels, so a fixture edit is a new image and a run against
the old one is refused before any root exists. **Fixtures are container images** states the whole
path.

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

A task whose difficulty is a behaviour of the runtime rather than of its own files adds one more
file, `hidden/<task>/image-check.mjs`, which the fixture build runs inside the image and fails on.

None of this changes the manifest schema, the record schema, the reducer, or the guard. A change
that does is a benchmark version bump, and a treatment-informed rewrite is always a new version.
