# Benchmark (Bench-1)

Trustworthy measurement infrastructure for the developer token-savings benchmark. Eval-only,
stdlib Python only. This package measures trials: for one task and one quality bar, how many
model tokens did the complete agent run consume with and without a knowledge system. It does not
itself produce a savings number, and nothing here touches the product runtime.

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
| `corpus.py`                 | the corpus branch: the pre-run reset, its guard, its stamp        | `test_corpus.py`                      |
| `verifier.py`               | hidden verifier registry, hidden layer, the run marker            | `test_verifier.py`                    |
| `images.py`                 | one pinned base image, one image per fixture, build and drift     | `test_images.py`                      |
| `container.py`              | a trial inside its image: mounts, argv, the run's egress proxy    | `test_container.py`                   |
| `producer.py`               | the natural arm's producer phase and its receipts                 | `test_phases.py`                      |
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
bootstrap golden), `fixtures/live/` (the smoke and real-task manifests, one frozen Vitest project
per task, the seeded lessons, the regression baseline), `fixtures/claude/` (sanitized
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

**Manifests and cost.** `real-manifest.json` (`bench2-local-pilot-1`) is the plan's Phase 1
local pilot: 8 tasks x (`off`, `tenjin_natural`) x 3 repeats = 48 consumer attempts plus 24
producer attempts. `local-arms-manifest.json` (`bench2-local-arms-2`) is 8 x (`off`, `flat`,
`tenjin_seeded`, `tenjin_natural`) x 3 = 96 consumer attempts plus 24 producer attempts, and
the seeded arm publishes two pieces per trial to the team shelf and deletes them at stop. The
recursive manifest (`bench2-recursive-2`) is 9 consumer attempts plus 3 producer attempts.
`max_budget_usd` stays 0.75 per attempt, producer attempts included, so the caps are 54 USD
(pilot), 90 USD (arms), and 9 USD (recursive); at the 0.14 to 0.36 USD the hooks smokes observed per attempt, expect
roughly 10 to 26 USD for the pilot and 17 to 43 USD for the arms manifest. Every run needs
`--plumbing --tenjin-source <tenjin data dir>` (the seeded config still names the team
shelf, so no run here is publishable), and the source data dir has to hold the three bundles
(`tenjin daemon start` writes them):

```bash
# the Phase 1 local pilot: off versus tenjin_natural, 48 attempts
python3 -m evals.benchmark.cli live-run --manifest evals/benchmark/fixtures/live/real-manifest.json --out <dir> --plumbing --tenjin-source <tenjin data dir>
# the full local comparison: off, flat, tenjin_seeded, tenjin_natural, 96 attempts
python3 -m evals.benchmark.cli live-run --manifest evals/benchmark/fixtures/live/local-arms-manifest.json --out <dir> --plumbing --tenjin-source <tenjin data dir>
# the recursive slice
python3 -m evals.benchmark.cli live-run --manifest evals/benchmark/fixtures/live/recursive-manifest.json --out <dir> --plumbing --tenjin-source <tenjin data dir>
# after any of them
python3 -m evals.benchmark.cli verify --run <dir>
python3 -m evals.benchmark.cli summary --run <dir>
```

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
with `pnpm@11.11.0`, `@anthropic-ai/claude-code` at the manifest's `pins.harness_version`, and
`tenjin-cli@0.1.0-alpha.15` installed globally by exact version, plus the `bench2-trial`
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
disagree with the manifest (`image_drift`), and the record carries the image id under
`isolation.image`. Because the install happens at build time, two builds of one fixture on two
machines may differ in a transitive dependency: the record names the build that ran, and a
locked run builds once and keeps the image. The base image is 710 MB and a fixture image 774
MB; a first base build is about 33s and each fixture about 20s, or 2 minutes for all eight.

**A trial runs inside the container.** The trial's roots are built on the host as before and
bind-mounted at the SAME absolute paths: the repository copy, `HOME`, the profile
(`CLAUDE_CONFIG_DIR`), `TENJIN_DATA_DIR`, the output root the entrypoint writes its daemon
report to, and the arm's settings file read-only, because `--settings` names a path outside
every other root. Same paths, because the product hashes the working directory into its local
records, the hook template resolves `{data_dir}` to an absolute path, and the transcripts
Claude writes under the profile are read back by the host. `node_modules` is copied out of the
fixture image into the trial's repository copy at preparation (`docker create` plus `docker
cp`, 788 files in under a second); it is the image's tree, Linux natives included, and the host
never runs it. The `claude` binary and the `tenjin` CLI come from the image, by exact version;
the daemon, shim and reporter bundles still come from the seeded data dir, which is a mount,
because they are the product build under test and platform-neutral JavaScript. The container
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
no DNS for an outside name: a lookup fails with `EAI_AGAIN`, proven on this machine's colima
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

None of this changes the manifest schema, the record schema, the reducer, or the guard. A change
that does is a benchmark version bump, and a treatment-informed rewrite is always a new version.
