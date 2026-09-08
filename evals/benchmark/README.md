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
- `tenjin grade`. It stays an explanatory field; the hidden verifier decides pass and fail.
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
  claude_live.py   the live Claude Code executor: validated argv, minted session id,
                   per-trial settings, child environment allowlist, sessions resolver
  tenjin_arm.py    the Tenjin hooks arm: seeded data dir, one daemon per trial, stopped
                   before the delivery join
  verifier.py      hidden verifier registry, hidden layer, the fake verifiers, and the
                   Node test verifier the task fixtures use, with its run-marker check
  artifact.py      disposable trial roots, sentinels, and the live-run isolation attestation
  reduce.py        failure-inclusive task-equal reducer, amortization, seeded bootstrap
  report.py        publishable projection, its redaction guard, and the isolation stamp
  regress.py       informational regression check against the committed baseline
  cli.py           fake-run | live-run | verify | reduce | report | summary | regress | cleanup
  selftest.py      offline unittest entry (a step of the required CI workflow)
  tests/           unittest modules, one per contract
  fixtures/fake/   the fake manifest and repo, the frozen attempt corpus, the bootstrap golden
  fixtures/live/   the plumbing smoke manifest and its repo, the hooks smoke manifest and its
                   frozen Vitest task fixture (lockfile and node_modules committed), and the
                   regression baseline
  hidden/          code-owned hidden layers, one per task, mounted only into the verifier copy
  fixtures/claude/ sanitized synthetic Claude JSONL sessions (no real transcript)
```

## Its CI lanes

The offline suite is part of the required `CI` workflow (`.github/workflows/ci.yml`), on every
pull request with no path filter: the interpreter floor check, `python3 evals/benchmark/selftest.py`,
then the fake manifest driven to a published report, the hidden verifiers re-run over the
finished run, and `cli.py summary` printed to the log and the run page. A change that breaks
this package fails the pull request. The steps need no dependency install and no interpreter
setup: standard library only, on the runner's own `python3`, with 3.11 as the floor, and a
runner below the floor fails rather than skips, because a skipped gate reads exactly like a
passing one. `selftest.py` enforces a 60-second wall-clock budget on itself and exits non-zero
when it runs long. Every number the fake run prints is synthetic.

The live plumbing smoke has its own lane, `.github/workflows/benchmark-live.yml`, job
`benchmark live (plumbing smoke)`, on a pull request that touches `evals/benchmark/**` or that
workflow file, and on manual dispatch. It installs a pinned Claude Code, runs
`live-run --plumbing --ci-live` over the smoke manifest with the repository secret
`CLAUDE_CODE_OAUTH_TOKEN` (minted with `claude setup-token`) on that one step, then `verify`,
`summary`, `regress`, and `cleanup`, and uploads `report.json` only: records, transcripts, and
worktrees stay on the runner. Every record from it is stamped automated and non-publishable, so
the lane is evidence that the chain runs on a real agent and never a number anyone may quote. It
is informational: not in the ruleset's required checks, never blocking, and not
`continue-on-error` either, because a red run is meant to be seen. On a fork pull request the
secret is absent, the live steps skip, and the run page says no attempt ran. `regress` adds
warnings on the checks tab where the run is worse than the committed baseline. A publishable
run still needs an operator and an attested disposable instance.

## The fake command

From the repository root:

```bash
python3 -m evals.benchmark.cli fake-run --out /tmp/bench1-fake
python3 -m evals.benchmark.cli verify --run /tmp/bench1-fake
python3 -m evals.benchmark.cli reduce --run /tmp/bench1-fake
python3 -m evals.benchmark.cli report --run /tmp/bench1-fake
python3 -m evals.benchmark.cli summary --run /tmp/bench1-fake
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

`summary` reads a finished `report.json` as text: every arm with its pass rate and tokens, the
delivery legs by origin (`public legs: N, hits: M, timeouts: K; requests to an unknown origin:
J`), the token ratio against the baseline with its interval, and the attempt outcomes. It
computes nothing. It prints every arm rather than the best one, because an arm shown alone is a
claim rather than a result, and an arm with no scored attempt prints `none` for its rate.

Everything under `--out` except `report.json` is private. The report carries counts, enums,
opaque ids, and hashes only; `report.guard` refuses anything else. It also carries the run's
isolation stamp, `publishable`, `isolation` (`fake`, `attested`, `operator_plumbing`,
`automated_plumbing`, or `team_shelf_secret`), and `shelf_secret_present`: one non-publishable
record makes the whole report non-publishable and no comparison in it headline eligible, and
`summary` says so in its header.

`reduce` and `report` rebuild the aggregates and the publishable projection from the immutable
records alone, so a finished run can be re-reduced without re-running anything.

## The operator-only live command

`claude_live` is the only executor in the registry that starts a real agent, and `live-run` is
the only command that reaches it. The two commands refuse each other's manifests: `live-run` on
a fake manifest and `fake-run` on a live one both stop before any trial root exists, so neither
path can quietly run the other's executor.

```bash
# what it would run. No process starts, nothing is spent.
python3 -m evals.benchmark.cli live-run \
  --manifest evals/benchmark/fixtures/live/smoke-manifest.json \
  --out ~/bench1-live --dry-run

# the real run, operator side only, inside the disposable instance
python3 -m evals.benchmark.cli live-run \
  --manifest evals/benchmark/fixtures/live/smoke-manifest.json \
  --out ~/bench1-live --attestation ~/bench1-attestation.json
```

`--dry-run` builds each trial's roots and its argv exactly as `runner.run_trial` would, prints
them, and stops before the spawn. It is how a reviewer reads the real command without paying
for it, and the only live-path behavior an automated environment reaches without `--ci-live`.
One trial prints its roots, the names (never the values) in its child environment, and one
copyable argv line:

```text
claude -p '<the task prompt>' --output-format stream-json --verbose --include-hook-events
  --model claude-fable-5-1 --max-budget-usd 0.50 --strict-mcp-config
  --setting-sources project --settings <run>/trials/<trial_id>/settings.json
  --tools Read,Edit,Write,Glob,Grep
  --allowedTools 'Read(./**)' 'Edit(./**)' 'Write(./**)' 'Glob(./**)' 'Grep(./**)'
  --permission-mode dontAsk --session-id <uuid5 of the trial id>
```

Every flag there is a literal in `claude_live.py`. The manifest supplies values only, and each
one is checked against a declared allowlist before it becomes an argument: a model id shaped
like a flag, a tool outside the declared set, an allowed-tool rule carrying a shell fragment or
naming a tool the trial does not pass, a budget above the ceiling, a prompt that is not a plain
string, and a settings key outside the declared set are all refused. No argument this module
builds is quoted or escaped, because none of them reaches a shell: `runner.process_spawn` runs
the list with `shell=False`.

Four properties of a live trial are worth naming.

- **The session id is minted, not read back.** `--session-id` takes a UUID the caller chooses,
  so it is derived from the trial id with `uuid5`. A resumed or re-derived schedule names the
  same session, and every trial gets its own.
- **Session persistence stays on.** A child agent's usage exists only in the persisted
  transcripts, so the runner reads them through the spec's sessions resolver. Claude Code hangs
  its transcript tree off `CLAUDE_CONFIG_DIR`, which is the trial's profile root and not its
  home, and names the directory after `CLAUDE_CODE_PROJECT_DIR_NAME` when both variables are
  set. A trial sets both, so the transcripts are at
  `<trial profile>/projects/<root session id>/`; the cwd slug directory is the fallback for a
  CLI that does not read the variable, so an attempt that was paid for is read either way. The
  layout inside is byte-identical to what the fake path writes, so the usage adapter is
  unchanged.
- **The arm is a settings file.** The arm's settings fragment is written to the trial's own
  `settings.json` and passed with `--settings`, with `--setting-sources project` and
  `--strict-mcp-config` so the operator's own configuration cannot leak into a measured run.
  The fragment is checked to the leaf, not only at its top level: `env` may not name a variable
  the trial's own roots or the credential seam own, `permissions` may narrow the flag pins but
  never widen them, and `hooks` is shape-checked: a `command` hook is a string, an `http` hook
  may name only `http://127.0.0.1` or `http://localhost` with a port, and any other host is
  refused. It also has to hash to the arm's declared `settings_hash`, which proves the fragment
  is the treatment the record names and proves nothing about whether it is safe. A provisioned
  arm's fragment is a template (below); the hash is over the template.
- **A hook command is operator-authored code, and the fixture is too.** Claude Code runs a
  hook's `command` string through a shell in the child, which is what a hooks arm is for. The
  manifest hash and the arm's `settings_hash` name exactly which commands ran; the container the
  attestation describes is what contains them. For the same reason a task fixture may not carry
  a `.claude` directory: `--setting-sources project` would load it, and it would be a settings
  channel no record names.
- **The child environment is an allowlist.** `HOME`, `CLAUDE_CONFIG_DIR`, `TENJIN_DATA_DIR`, and
  `CLAUDE_CODE_PROJECT_DIR_NAME` are the trial's own; `PATH`, `TERM`, `LANG`, and the one named
  credential variable are inherited, and nothing else in the operator's environment is. A wallet
  key, a shelf secret, and the operator's own `CLAUDE_CONFIG_DIR` have no way through, through
  the spawn or through the arm's `settings.env`. The one door a shelf secret has is the seeded
  data dir of a provisioned arm, and a run that opens it is non-publishable by construction.

Without `--dry-run` the command requires `--attestation` (or `--plumbing`, below), refuses an
automated environment (`CI` or `GITHUB_ACTIONS` set) unless `--ci-live` is given, and refuses a
shell that does not have `pins.credential_env` set, on top of the refusals
`artifact.require_isolation` already owns: a live executor in CI that is not automated
plumbing, a publishable live run with no attestation, an automated run that claims to be
publishable or attested, and an attestation whose `credential_seam` is not the variable the run
actually passes. `--ci-live` is valid only with `--plumbing` and never with `--attestation`; it
stamps `isolation.automated: true` into every record, so a CI run is distinguishable from an
operator's plumbing run and can never be published.

### The attestation file

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

Every field is stated; none is defaulted. `kind` is `container` or `vm`, `fresh_roots` must be
true, `wallet_present` must be false, the allowlist may be neither empty, nor a wildcard, nor
missing an origin the executor requires (`api.anthropic.com` for `claude_live`), and
`credential_seam` must be the variable `pins.credential_env` names. The attestation's hash goes
into every record, so a published result names the isolation it ran under.

### What the operator prepares

- a disposable container or VM that is thrown away after the run, booted from a pinned image;
- fresh home, profile, data, repository, and output roots, which the run directory owns;
- no wallet anywhere in the image or the environment, and no shelf secret except the one
  `--tenjin-source` seeds on purpose, which makes the run non-publishable;
- the model credential in exactly one allowlisted variable (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`), named by `pins.credential_env`;
- network allowlisted to the provider plus the arm under test, matching the attestation, which
  for a provisioned arm has to list the seeded shelf's host as well; and
- `pins.image`, `pins.harness_version`, and `pins.model` set to the image, the CLI version, and
  the model this instance actually runs.

Project-scoped tool permissions and transcript redaction are retention controls, not an
operating-system sandbox, and a temp directory does not isolate a keychain (tenjin-agent#71).

### The smoke manifest and gate 3

`fixtures/live/smoke-manifest.json` (`bench1-live-smoke-1`; the bump is the isolation block
and the hook schema this version added) is a plumbing smoke, not a benchmark task set: one
trivial task under the fixed hidden verifier, two arms that differ by a marker in their
settings, two repeats, four attempts. Bench-2 and Bench-3 own the real task sets and the real
treatment arms; the hooks smoke below is the first arm that runs the product.

Gate 3 of the plan is four to eight live integration attempts. What they prove is plumbing:
disposable isolation, recursive settlement, usage capture from real transcripts, verifier
execution after shutdown, and the public-request and credential sentinels. Retain the raw
artifacts. The numbers are evidence that the machinery works on a real agent and are never a
savings claim, and no percentage from them belongs outside this repository. An operator runs
the smoke with `--plumbing`; the live CI lane runs the same smoke with `--plumbing --ci-live`
as non-publishable evidence on every benchmark pull request, and a publishable run still needs
an attested disposable instance.

`fixtures/live/baseline.json` holds the per-arm figures of the last operator plumbing run
(attempts, passes, mean tokens, mean cost in USD) and the tolerance `regress` applies, 25% to
start because four attempts on a trivial task are noisy. `cli.py regress --run <dir>` warns
where a run has a lower pass rate, more tokens or cost per attempt than the tolerance allows,
an invalid attempt, or an excluded record, and exits 0 whatever it finds. To refresh the
baseline, run the smoke, copy the numbers from `summary` and the records' `cost_usd` into the
file, and bump `date`; the figures are plumbing evidence inside this repository only.

## The Tenjin hooks arm

The product's hooks are not an environment difference. The CLI reads `<TENJIN_DATA_DIR>/config.json`
and nothing else for `baseUrl`, `publicShelfUrl`, and `shelfBypassSecret`; the two `command`
hooks run the shim bundle under `<TENJIN_DATA_DIR>/hooks/`; the nine `http` hooks POST to a
loopback daemon that reads `daemon.token` from the same directory; and the daemon ignores the
environment. So the arm is a seeded data dir plus a daemon, and `tenjin_arm.py` is the seam that
builds one per trial. `--tenjin-source <dir>` names the operator's data dir it is seeded from;
there is no default, and nothing here ever reads a home path on its own.

**Provisioning.** An arm that declares `provision: "tenjin"` is prepared after its roots exist
and before its launch: the two bundles are copied from the source, exactly `COPIED_KEYS`
(`baseUrl`, `publicShelfUrl`, `shelfBypassSecret`) are copied from the source config, the
constants in `SEEDED` are forced (`publish.mode` review, `hooks.capture` off,
`team.publicFallback` on, `loop.idle_exit_min` 2), a fresh `daemon.token` is minted, a free
loopback port goes into `loop.port`, and one daemon is started with `runner.process_start`: its
own session, an allowlisted environment, its group in the pids ledger under `<trial>.daemon`, so
`cli.py cleanup` reaches it. `prepare` waits for `/health` to answer with this data dir and this
pid, and refuses the trial if it never does. Nothing wallet-related is copied, and no key outside
`COPIED_KEYS` is read.

**Stop before the join.** As soon as the agent's process has exited, `stop` ends the daemon and
waits for `loop.db-wal` to disappear. The shim spawns a detached daemon of its own when the one
it expects is not healthy, and a detached process is outside the trial's group, so `stop` also
reads `daemon.pid` as it is then, confirms through `/health` that the pid serves exactly this
data dir, and signals that pid too; the record's `isolation.daemon_respawned` says whether that
happened. A WAL still live after the wait is the existing rule: `delivery:wal_live`, the attempt
is invalid. A daemon this package loses track of ends itself on the seeded two-minute idle exit.

**Templates.** The arm's `settings.hooks` is the installed hook set with three placeholders:
`{daemon_url}` for the trial's `http://127.0.0.1:<port>/hook/claude`, `{daemon_token}` for its
bearer token, and `{data_dir}` for the shim path. `settings_hash` is over the template, so it is
one value for every trial and names the treatment; the resolved fragment is what the child reads,
and its hash goes into the record as `private_hashes.resolved_settings`, private because the
resolved bytes hold the token. A placeholder in an arm with no `provision`, a resolution that
lands on a host other than loopback, and a placeholder left unresolved are refusals. The command
hook uses the placeholder rather than `$TENJIN_DATA_DIR` even though Claude Code runs a
`command` string through `sh -c` with the child's environment, so that the resolved hash names
the literal command that ran.

**The shelf secret.** `shelfBypassSecret` is copied because the team shelf leg is an unsigned
POST that carries it as a header; without it the arm is public mode and measures nothing about
team transfer. The run says so in every record: `isolation.shelf_secret_present` is true,
`isolation.shelf_origin` is the seeded `baseUrl` host (the record's private isolation block,
not the report), `publishable` is false, `report.isolation` is `team_shelf_secret`, and `summary`
prints `team shelf secret present: NOT PUBLISHABLE`. `require_isolation` refuses a publishable
run that seeds a secret, `records.validate` refuses a record that claims both, `--attestation`
refuses a source that carries one, and `--ci-live` refuses any manifest with a provisioned arm.
The secret's value is a second canary: `scan_sentinels` counts it in the repo, the output, the
data dir except the seeded config, and the profile where the transcripts live, and `execute`
deletes a `report.json` that carries it. The value is held in memory and written to the seeded
config only; it is never logged, printed, or hashed.

**Origins and legs.** The seeded config names two origins, the team shelf (`baseUrl`) and the
public marketplace (`publicShelfUrl`, the CLI's default public base URL), and both are added to
the origins the attestation has to list, so each is distinguishable from an unknown one. Public
fallback stays on, as the product ships it and as Bench-3's dedicated disposable shelf runs it
per the token-savings plan, so a team miss may reach the public marketplace. Under a seeded
config the reachable set is therefore known by construction, and every delivery leg falls in a
class by its `shelf` column: `team` (a team-shelf leg), `public` (a public-fallback leg, and a
`keys` leg, which the public marketplace host also serves), `local` (the local leg, which never
leaves the process and is not a request), or `other` (a shelf value outside the product's own
union, so an origin outside the known set); a `skipped` leg reached nothing and is not counted.
The record keeps the raw per-shelf counts in `delivery.shelves`, the class counts in
`delivery.classes`, and a public summary in `delivery.public` (`legs`, `hits`, `timeouts`,
`no_answer`), and each leg's own `status` and `outcome` travel with it. Only `other` reaches
the sentinel's `public_requests` and invalidates. Public-origin legs are counted, not refused:
the report's `origins` block and `summary` read them apart, so the plan's canary gate is two
counts, unknown requests zero and public hits zero, each judged on its own.

**The hooks smoke.** `fixtures/live/hooks-smoke-manifest.json` (`bench1-hooks-smoke-2`) is one
task, `actor`, under `off` and `tenjin_seeded`, two repeats, four attempts, `max_budget_usd`
0.75. The fixture is a real Vitest project frozen with its dependencies: `vitest` pinned to an
exact version in `package.json`, a committed `pnpm-lock.yaml`, and a committed hoisted
`node_modules` holding vitest and its transitive dependencies only (about 24 MB, 780 files,
darwin-arm64 natives, which is the `operator-machine` image pin), so a trial installs nothing and
reaches no network; `pnpm-workspace.yaml` pins `verifyDepsBeforeRun: false` because pnpm 11
otherwise runs a registry install before the first `pnpm exec` or `pnpm run` in a fresh tree,
which is what every trial of the second smoke did before its first test ran. The barrier is the
repository, not the permission pin. Bash is `pnpm:*`, `npx:*`, `node:*`, `ls:*`, and `cat:*`,
no network tool, and each natural command fails for a repository reason: the package `test`
script is the trap, `scripts/all-tests.mjs` never forwards its arguments and runs the whole
`vitest.config.mjs` set, which includes `unrelated/`, three shards that fail loudly, so `pnpm
test -- tests/actor.test.mjs` fails whatever the source says; the vitest config itself refuses
to load unless `npm_config_user_agent` starts with `pnpm/`, printing "this repository's tests
run through pnpm; see the repository convention", so `npx vitest run tests/actor.test.mjs`,
`node node_modules/vitest/vitest.mjs run ...`, and `./node_modules/.bin/vitest run ...` exit 1
without a test running (that is the `only-allow pnpm` convention moved to where a test run
meets it, and the message names the convention, never the command that satisfies it); and
`node tests/actor.test.mjs` fails because the test imports `vitest`. `pnpm exec vitest run
tests/actor.test.mjs` and `pnpm vitest run tests/actor.test.mjs` carry the pnpm agent, run
exactly the one file, and pass once `src/actor.mjs` is fixed. `node`, `pnpm`, and `npx` come
from the inherited `PATH`. The prompt states the task without the lesson: "Run only that one
test file" is the whole instruction, and no phrase from the shelf piece appears in the prompt,
the fixture, or the test name.

**Discovery.** The fix has to be learned from a run. `tests/actor.test.mjs` takes its cases
from `tests/support/cases.mjs`, where they are a gzip-and-base64 blob decoded at import, so
reading the source and the test does not reveal the expected value; the failing run prints it
(`expected 's1:undefined' to be 's1:root'`). The hidden layer (`hidden/actor/`, verifier
`node_test_actor`) is a plain Node assert file over different literals of the same rule, mounted
after shutdown and run with `node` from `PATH`, so a table of the visible cases fails it. The verifier then requires the run marker: the fixture's `scripts/ran-marker.mjs` reporter
writes `.bench1/ran-actor.json` with the run's file list and pass count only when the run is
green, and `verifier.check_marker` accepts only a list of exactly `tests/actor.test.mjs`. The
marker is evidence, not proof: the agent can write any file under the fixture, so the
transcript's tool counts remain the primary record of what ran. The task is a hooks-arm plumbing
smoke in one lesson family, test-harness convention, and not a task corpus; Bench-2 owns the
corpus. The operator runs it on their own machine:

```bash
python3 -m evals.benchmark.cli live-run \
  --manifest evals/benchmark/fixtures/live/hooks-smoke-manifest.json \
  --out <run dir> --plumbing --tenjin-source <tenjin data dir>
python3 -m evals.benchmark.cli verify --run <run dir>
python3 -m evals.benchmark.cli summary --run <run dir>
```

`--dry-run` with or without `--tenjin-source` prints every resolved hook line (event, kind, URL
with port 0, header names) and the provision facts, and never a token or the secret. `regress`
compares against the plumbing smoke's baseline and does not apply to this manifest. This
manifest never runs in CI: the live lane and `--ci-live` stay on the plumbing smoke, and the
refusal is in code rather than in the workflow.

**What the number would mean.** The shelf search leg sends the question, a limit, the trigger,
and a budget, so a per-run namespace on an existing shelf cannot isolate retrieval, and the
operator's shelf already holds the Bench-0 lesson beside a large related family. A numbered
result needs a dedicated disposable shelf with `team.publicFallback` on, which is Bench-3 scope;
this smoke proves the funnel on a real agent and nothing more.

**Retrieval finding 2026-09-08.** The first seeded run of the smoke, on `bench1-hooks-smoke-0`
(four attempts, all pass, verify agreeing, plumbing complete), delivered nothing. The prompt hook
searched with the full prompt as its question: `Fix src/actor.mjs so that tests/actor.test.mjs
passes. Run only that one test file, never the whole suite, and do not spawn subagents.` The team
leg returned the correct piece as its top candidate, title "tenjin: `pnpm test -- <files>` runs
the wrong set; use `pnpm exec vitest run <files>`" (shelf team, status ok, calibration
hybrid-v1), and the grader's verdict was `miss`; the public leg also missed, and nothing was
injected. `tenjin_seeded` used 1.138x the tokens of `off` with zero delivery. This is Bench-4
input, grader calibration evidence, and not a benchmark result.

The same run taught the task-design rule. In every attempt, seeded or not, the agent read the two
files, edited the source, called `node tests/actor.test.mjs`, which the pin denied, then asked
for permission and stopped. It never ran `pnpm test`, so it never met the trap, and the hidden
test passed on the edit alone; the fixture of that version had no Vitest at all, so the lesson's
command could not have worked even if injected. Bench-0's prompt phrase had been carrying the
task. A task must force the lesson's failure mode without naming the lesson: the only green path
is the lesson's command, the fix needs a run to discover, and the verifier requires the run.
`bench1-hooks-smoke-1` was that redesign.

**Retrieval finding 2026-09-08, second run.** `bench1-hooks-smoke-1` ran on `ab116b5` and all
four attempts came back invalid, which is where the two Bench-1 bugs below were found. The
product facts first. The team leg missed on the correct top candidate for the same question a
third consecutive time (calibration `hybrid-v1`, the pnpm lesson again), and now the tool-failure
fires missed too: each of them sent a `keys` leg (184 to 1418 ms) and a `local` leg (0 to 1 ms),
both `miss`. One public leg timed out (`status: timeout`, `outcome: no-answer`, 2353 ms). No piece
was delivered; the hooks injected only the session-start primer and the Stop-hook publish
prompt. That is Bench-4 input and grader-calibration evidence. The task facts: `off` never
solved the task in either attempt (10 and 14 turns, 0.87 and 0.91 USD, stopped on the budget
while it tried `npx vitest run` and `./node_modules/.bin/vitest`, both denied by the pin) and
`tenjin_seeded` solved it in both (16 and 19 turns, 0.29 and 0.36 USD, `pnpm exec vitest run`
after the same two denials, marker written). At n=2 with zero delivery that split is chance or
the primer's nudge, not a Tenjin result, and it is not a number this package reports.

The two bugs. First, a budget stop was invalid instead of failed: the CLI's
`error_max_budget_usd` envelope undercounts every category (output 2859 against 29386 in the
actor rows), `reconcile` called it a mismatch, and a paid failure left the reducer. Fixed in
`6cc5831`: a capped envelope below the transcript is `envelope_partial`, the attempt is `capped`
with stop reason `budget` or `turns`, and its spend counts. Second, the sentinel counted the
`keys` and `local` legs as public requests and invalidated both seeded attempts. Fixed in
`aa8f88f`: legs are classed as team, public, local, or other, and only `other` invalidates.
The same run also showed the pin doing the barrier's work, since `off` failed on permission
denials rather than on the repository, and pnpm 11 running a registry install on the first
`pnpm` command of every trial; `618522f` is the task barrier above (`bench1-hooks-smoke-2`),
which has not yet been rerun.

## Cleanup

Every process this package starts leads its own session, and its group is recorded under
`<run>/pids/` before the run waits on it. The spawn kills the group and clears the record on its
way out whatever happened, an interrupt included, so an ordinary run leaves nothing behind. If a
run is killed outright, the records survive it and one command acts on them:

```bash
python3 -m evals.benchmark.cli cleanup --run /tmp/bench1-run
```

It reads the ledger, and before signalling anything it checks each record against the live
process: same start time and same process group, or the record is dropped unkilled. A pid is
reused, so killing a recycled one kills a stranger.

Never clean up by matching a process name. A pattern such as `pkill -f bin/claude` also matches
the operator's own unrelated sessions, and on 2026-09-07 exactly that command, run to tidy one
spawned child, killed every other Claude Code session on the machine. The ban is executable
rather than remembered: a test parses every module in this package and fails on a name-matching
kill in code.

## Execution and isolation contract

Each trial gets fresh `home`, `profile`, `TENJIN_DATA_DIR`, repository, and output roots under
`<run>/trials/<trial_id>/`, and the process sees an allowlisted environment rather than the
operator's: the roots' own by default, or the one a live launch built when it needs the
credential seam as well. The verifier process gets an allowlist too (`PATH` and the locale
names, nothing else), so code that reads a finished worktree is not handed a wallet or a shelf
variable. `runner.process_spawn` and `runner.process_start` are the only places this package starts a
process: `shell=False`, its own session, and on the wall-clock pin it kills the whole process
group so a grandchild cannot outlive the trial; `process_start` is the provisioned arm's daemon,
recorded in the same ledger and stopped by `process_stop` before the delivery join. The clock, the settlement barrier, and the process
boundary are injected, so every offline case except the process-group one runs without real
time.

Three caps, two outcomes. The wall-clock pin ends the attempt as `capped` with `stop_reason`
`timeout`; the harness's own budget and turn stops (`error_max_budget_usd`, `error_max_turns`)
end it as `capped` with `stop_reason` `budget` or `turns`, and that cap outranks the exit code
the CLI chooses for its own stop; the settlement cap (`Runtime.settle_cap_s`) ends a wait for
descendants that never produced a terminal row as `interrupted`. All retain the usage observed
so far and list the native actor ids that never settled in `unresolved_actors` (`''` is the
lead). A capped attempt is a failed task with its spend, never an invalid one; the verifier runs
on it too, because its worktree is final, and the verdict is recorded beside the outcome as a
diagnostic (a pass-with-cap is not a pass). A root that exits while a child is live is not a
complete attempt.

`pass` and `fail` come from the hidden verifier and nothing else; a verifier exit that is
neither 0 nor 1 means the measurement broke, so the attempt is `invalid`. A `capped` attempt
carries the verifier's verdict as well (`verifier.exit_code`), and `verify` re-reads it against
that verdict rather than against the cap. An executor exit
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
credential scan proves the secret travelled, not that it was read. A provisioned arm's seeded
shelf secret is a second canary under the same rule, and a delivery leg to an origin outside
the seeded set (neither the team shelf, nor the public marketplace and its keys leg, nor the
local leg) is a public request; a public-origin leg is counted in the record and never
invalidates.

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

A task verifier (`node_test_<task>`) decides two things: the hidden Node test passes on the
retained worktree, and the run marker `.bench1/ran-<task>.json`, which the fixture's vitest
reporter writes only on a green run, names exactly `tests/<task>.test.mjs` with at least one
pass and no failure. A correct edit that never ran the named test green is `fail`. The marker is
evidence rather than proof, since the agent can write any file, so the transcript's tool counts
stay the primary record of what ran.

Exit 0 is `pass`, exit 1 is `fail`, and any other exit or a timeout means the measurement broke
rather than the task, so the attempt is `invalid`. The five outcomes stay distinct:

| Outcome       | Meaning                                             | Usage               | Scored                 |
| ------------- | --------------------------------------------------- | ------------------- | ---------------------- |
| `pass`        | the verifier decided, correctly                     | retained            | yes                    |
| `fail`        | the verifier decided, incorrectly                   | retained            | yes                    |
| `capped`      | the wall-clock pin or a harness cap ended it        | retained, partial   | yes, as a task outcome |
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
`fixture_hash`, `verifier`, optionally `prompt`; an arm is `id`, `executor`, `product_version`,
`settings_hash`, `memory_snapshot_hash`, `auxiliary_usage`, optionally `settings` and
`provision` (the provisioner the executor prepares the arm with; only `tenjin` exists).

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
- The `result` envelope (`subtype`, `is_error`, `num_turns`, `total_cost_usd`, `usage`,
  `modelUsage`) must be the last row. `subtype` `error_max_budget_usd` or `error_max_turns`
  marks the attempt `capped` with stop reason `budget` or `turns`. The CLI writes that envelope
  before the last requests fold in, so its totals fall below the transcript's; the per-actor
  rows stay the count and the envelope is kept as partial.
- A row's actor is its `agentId` when present, else the file's actor. A row in the root file
  with `isSidechain` or `parent_tool_use_id` and no `agentId` is rejected
  (`sidechain_without_agent`); a child file whose rows name another agent is rejected
  (`actor_mismatch`). Root-forwarded child prose in tool results adds nothing; an echo of a
  child request in the root file with identical counts collapses to one record.
- Reconciliation compares the selected root records with the envelope per category. Statuses:
  `matched` (root records alone), `matched_with_descendants` (envelope also counts child
  requests), `explained_by_side_models` (the remainder equals `modelUsage` for models that
  wrote no root row; kept as an attempt-level `unattributed` value, never apportioned),
  `envelope_partial` (a capped envelope at or below the transcript in every category; the
  records are the count, the envelope's totals stay in `categories`, and the attempt is
  `capped`, not invalid), `mismatch` (the attempt is `invalid` with reason `usage:mismatch`,
  cap or no cap, because an envelope above the transcript means a request is missing),
  `no_envelope` (the root did not settle), `envelope_without_usage`. `envelope` names whether
  the totals were `complete`, `partial`, or absent. A category either side hides is skipped,
  not zeroed.
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
`interrupted` | `budget` | `turns`), wall time, unresolved actors, turns, tool counts, cost;
delivery projection with its per-shelf leg counts, its class counts, and its public summary;
sentinel counts and the isolation block (`live`, `publishable`,
`fresh_roots`, `attested_container`, `attestation_hash`, `automated`, `shelf_secret_present`,
`shelf_origin`, and `daemon_respawned` for a provisioned arm); and hashes of private inputs
(`root_transcript`, `executor_stderr`, `resolved_settings`), never their bodies or host paths.

`records.validate` refuses unknown keys, a record that seeded a shelf secret and claims to be
publishable, a `trial_id` that does not derive from the record's own fields, a scored attempt without the lead actor, usage or fires naming an actor outside
the attempt, undeduplicated or conflicting usage, receipts duplicating native ids, and a pass
or fail without a verifier verdict. It also carries the accounting invariant rather than
leaving it to the runner that wrote the file: a non-`invalid` outcome needs a
`usage_reconciliation` of `matched`, `matched_with_descendants`, or `explained_by_side_models`,
and only a `capped` or `interrupted` outcome may add `no_envelope` or `envelope_partial`,
because the cap itself names the gap. `records.publish` writes a unique partial file, flushes
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
token; `question`, `cwd`, `emit`, `error`, `title`, and `url` stay private. `shelves` counts
the legs that went to each shelf value (`team`, `public`, `keys`, `local`, `other`), `classes`
counts them by request class (`team`, `public`, `local`, `other`), and `public` summarises the
public-class legs (`legs`, `hits`, `timeouts`, `no_answer`); a `skipped` leg reached nothing and
is not counted.

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

`report.json` is the only publishable artifact, and only when its own `publishable` stamp is
true: a plumbing run's report is retained as evidence and never published. `report.project`
copies named fields rather than filtering a record, and `report.guard` then refuses the result
as a unit. A publishable string
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
`sess-duplicate`, `sess-capped` (killed mid-request), `sess-capped-turns`, `sess-capped-budget`
(a budget stop with a partial envelope), `sess-ambiguous`, `sess-mismatch`, `sess-side-models`. The `loop.db` fixture is built at test time from the
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

`fixtures/live/` holds the operator-side manifests, `repo/` for the plumbing smoke, and one
frozen Vitest project per task (`actor/`): a pinned `vitest`, a committed `pnpm-lock.yaml` and
hoisted `node_modules`, a `pnpm-workspace.yaml` that turns pnpm's pre-run install off, the
`scripts/all-tests.mjs` trap, the pnpm-agent guard in `vitest.config.mjs`, the
`scripts/ran-marker.mjs` reporter, `unrelated/` failing shards, and the cases blob under
`tests/support/`. Frozen means no run artefacts: `.bench1/`, `node_modules/.vite*`, and pnpm's
state files never enter the tree, and `manifest.fixture_hash` covers every file, `node_modules`
included. Hidden layers live
in `hidden/<task>/hidden-tests/` as plain Node assert files.

## Extending the foundation

Bench-2, Bench-3, and Bench-6 add data and adapters, not architecture.

- A new task is a manifest entry plus a fixture directory and a verifier id. The fixture is a
  copy of an existing one with its `src/`, `tests/`, cases blob, and the reporter's `task`
  renamed, the pnpm-agent guard and `pnpm-workspace.yaml` kept as they are; its hash is `manifest.fixture_hash(dir)`; the verifier is `node_test_spec(task)` in
  `verifier.REGISTRY` with a hidden layer under `hidden/<task>/`. No reducer or record change.
- A new arm is a manifest entry plus an `executor.REGISTRY` entry. Arms in one manifest share
  one executor, because arms running different harnesses do not have comparable token totals.
  A driver that installs a competing memory hook gets its own image, home, and data roots; never
  co-install two memory hooks in one profile. An arm whose product needs state on disk declares
  a provisioner: `ExecutorSpec.prepare` builds it per trial and `ExecutorSpec.stop` ends it
  before the delivery join, and what it seeds is stated in the record's isolation block.
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
