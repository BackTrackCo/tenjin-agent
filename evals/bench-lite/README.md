# bench-lite

Does a team shelf make the **second** agent cheaper?

One measurement is a pair of tasks. A **producer** task (A) is solved from scratch and yields a
finding worth keeping. A **consumer** task (B) is different work that needs that same finding.
Each pair runs under two conditions:

| condition | producer (A)                                      | consumer (B)                                  |
| --------- | ------------------------------------------------- | --------------------------------------------- |
| `off`     | fresh worktree, no Tenjin hooks                   | fresh worktree, no Tenjin hooks               |
| `tenjin`  | hooks on; the turn-end arm captures and publishes | hooks on; the prompt arm searches and injects |

If the loop works, B's token total under `tenjin` is lower than under `off` by more than A's
capture overhead. That delta, per pair, is the number the whole thing exists to produce.

Everything is stdlib Python 3. No dependencies, no API key of its own — the agent runs under the
operator's existing Claude Code login.

## Quick start

```bash
# once: build and verify the bench data dir (configures the CLI, creates the bench wallet)
python3 evals/bench-lite/run.py prepare

# see exactly what a run would do, without calling the agent or touching the shelf
python3 evals/bench-lite/run.py --pairs evals/bench-lite/pairs.json \
    --conditions off,tenjin --repeats 3 --model claude-sonnet-5 \
    --out runs/2026-09-14a --dry-run

# for real
python3 evals/bench-lite/run.py --pairs evals/bench-lite/pairs.json \
    --conditions off,tenjin --repeats 3 --model claude-sonnet-5 --out runs/2026-09-14a

# afterwards: stop every daemon and retract this run's posts from the BENCH shelf only
python3 evals/bench-lite/run.py cleanup --out runs/2026-09-14a
```

`run` is the default verb, so the middle two commands work with or without the word `run`.

## `pairs.json`

A JSON array. Each entry is one producer/consumer pair:

```jsonc
[
  {
    "id": "pgvector-collation", // unique; names the records and the report rows
    "producer": {
      "repo": "tenjin-agent", // "tenjin" | "tenjin-agent"
      "base_commit": "9f3c1a2", // any revision the checkout can resolve
      "prompt_file": "pairs/x/producer.md", // relative to pairs.json's own directory
      "oracle": {
        "copy": [
          // copied in AFTER the agent finishes
          { "from": "pairs/x/oracle/a.test.ts", "to": "src/lib/__bench__/a.test.ts" },
        ],
        "command": "pnpm vitest run src/lib/__bench__/a.test.ts",
        "timeout_s": 900, // optional oracle timeout, default 1200
      },
    },
    "consumer": {/* the same five keys */},
  },
]
```

Rules the runner enforces:

- `repo` must be `tenjin` or `tenjin-agent`. Each maps to a local checkout under the workspace
  root; worktrees are cut from it with `git worktree add --detach`, and the checkout itself is
  never checked out, never modified, and never left with a stray worktree.
- `base_commit` is fetched if the checkout does not already have it.
- Every path in `prompt_file` and `oracle.copy[].from` is relative to the directory holding
  `pairs.json`; `oracle.copy[].to` is relative to the worktree.
- **The oracle command must name its files.** A bare `pnpm test`, `pnpm vitest` or `vitest run`
  is refused before it runs: on this laptop that forks ~35 workers plus testcontainers. The
  refusal is recorded as an oracle error, not a pass.
- The oracle's verdict is its **exit code**. Never a grep for "FAIL" — a passing vitest run
  prints the word.

Oracle files are copied in _after_ the agent exits, so the agent never sees the test it is
graded by and cannot special-case it.

## What a session does

1. `git worktree add --detach <scratch>/repo <base_commit>` from the mapped checkout.
2. Make sure the worktree has a `.claude/settings.json` (see isolation, below). For `tenjin`,
   copy the template data dir and run `tenjin install` with `HOME` pointed at the worktree.
3. `pnpm install --frozen-lockfile --prefer-offline` in the worktree, with `CI=true`.
4. Run the agent: the prompt goes in on **stdin**, so prompt length is not an argv limit.
5. Stage everything and save the agent's diff as `agent.patch` in the record directory — the
   worktree is removed, the diff is kept.
6. Copy the oracle files in, run the oracle command under a timeout, record the exit code and
   output tails.
7. For `tenjin`: stop the loop daemon, then read the ledger (below).
8. Remove the worktree.

The diff is taken in a `finally`, so a capped or crashed session still leaves its `agent.patch`
behind. It lands in that session's own directory under `sessions/`, not in the run-dir root.

## Runtime: the oracle must see the same node the agent did

The oracle runs under `bash -c`, never `bash -lc`, and every runner-owned subprocess gets the
directory of the resolved `node` prepended to `PATH`. This is not defensive styling. A real run
put its oracle on Node 18.14.2 while the runner was on 24.19.0, and corepack died with
`URL.canParse is not a function` before a single test loaded, which reads as a broken repo rather
than a broken PATH. The `-l` was the cause: a login shell re-sources the profile and rebuilds
`PATH` from scratch. Each session now records `node --version` and `pnpm --version` as its oracle
env sees them, and the report raises a **Runtime skew** section if sessions disagree.

## The capture turn

Under `claude -p` the product's turn-end nudge has nowhere to land. The Stop arm fires and emits
its "publish it now" context, but a headless run ends at that moment, so a producer captures
nothing where an interactive session would have published. Smoke-3 showed exactly this: the
producer's Stop arm fired twice with reason `no-question` and published **0**, while the
consumer, which had mid-session turns to act in, published **2** on its own.

So a `tenjin` producer gets one follow-up turn. It resumes the same session
(`--resume <session_id>`, same flags, env, cwd and data dir) and its prompt is **the Stop arm's
own emitted text, read back out of that session's `loop.db`** — the product's current wording
under this run's config, not a copy that drifts. A verbatim fallback is used only if the ledger
holds no stop emit.

`--resume` keeps the session id and appends to the same transcript (verified), so the transcript
totals below cover the capture turn without extra bookkeeping. It is recorded as its own
`capture` sub-record with usage, cost, wall time and turns, and the ledger is read **after** it,
so anything it publishes shows up in the funnel.

The agent's patch is taken **before** the capture turn, so the recorded diff is task work rather
than the finding. A second diffstat afterwards makes any code the capture turn touched visible.

Off by `--no-capture-turn`. Capped producers and every `off` session skip it, since in `off`
there is no shelf to publish to.

## Usage is summed from the transcripts, not the JSON

`--output-format json` reports the **main agent only**. Smoke-3's tenjin consumer delegated once
and reported 1.89M tokens against $8.16 of cost; its transcripts hold 12.66M for the main agent
plus 4.78M across one subagent, 17.44M in total, which is what $8.16 actually buys.

So after each session the runner reads
`~/.claude/projects/<slugged worktree path>/<session_id>.jsonl` plus every `*.jsonl` under
`<session_id>/subagents/`, and sums the four usage fields over assistant rows **deduped on
`requestId`** (falling back to the message id) — a transcript writes a row per streamed block,
and counting rows multiplies the total. Records carry `usage_main`, `usage_subagents`,
`usage_total` and the subagent file count; `cost_usd` still comes from the JSON. The report
compares on `usage_total`.

Validated offline against smoke-3: the three sessions with no subagent match their JSON total
**exactly**, to the token.

## A failed producer invalidates its repeat

A producer that is capped or errors never reaches its Stop hook, so under `tenjin` nothing was
captured and nothing was published. Running the consumer against that empty shelf would measure
the absence of a publish and report it as the absence of reuse.

So the runner works in groups of one (pair, condition, repeat), producer first:

- **`tenjin`**: the consumer is **skipped**, and both sessions are marked
  `invalid: producer_capped` or `producer_errored`.
- **`off`**: there is nothing to publish, so the consumer still runs; the repeat is flagged so it
  can be excluded alongside its `tenjin` counterpart.

Invalid sessions are excluded from every median and total and listed in their own report section.
`--workers` parallelizes whole groups, never the two halves of one.

A timed-out agent is killed by process **group**, not by pid, so its own `pnpm` and `vitest`
children die with it. The pid and whether the group was confirmed gone are both recorded.

## Isolation

The agent runs under the **real `HOME`**, and the isolation comes from
`claude --setting-sources project` plus a per-session Tenjin data dir.

### Why not redirect HOME

The obvious sandbox — `HOME=<sandbox> claude -p --setting-sources user` — does not work on this
machine. Both of these were measured, and both come back `"result": "Not logged in · Please run
/login"`, exit 1, zero tokens:

```
HOME=<sandbox> claude -p ... --setting-sources user
CLAUDE_CONFIG_DIR=<sandbox>/.claude claude -p ...        # real HOME, relocated config dir
```

On macOS the subscription login is in the Keychain, and the Keychain lookup is keyed to the
config directory, so settings and credentials cannot be separated that way. The supported way to
run headless under a relocated config dir is `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`
— which is an interactive login, so the harness cannot mint one on its own.

### What is used instead

`--setting-sources project` loads hooks, permissions and skills from the **worktree's own
`.claude/`** and nothing else. Measured in a sandbox session:

|                                       | result                                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| operator's user hooks                 | did not fire (only the project hook fired)                           |
| operator's user skills                | absent (53 slash commands, all built-in; no `tenjin-*`)              |
| operator's global `CLAUDE.md`         | absent (the agent answered NO when asked about a rule that is in it) |
| project `.claude/settings.json` hooks | fired                                                                |
| project `.claude/skills/`             | loaded                                                               |
| login                                 | works, real token counts and cost                                    |

So the two conditions differ in exactly one thing: whether `tenjin install` ran against the
worktree before the agent did.

- **`off`**: the worktree's `.claude/` is whatever the repo ships at the base commit (an empty
  `{}` settings file is created if it ships none). The data dir is an empty directory — no team
  config, no wallet — so an agent that reaches for the `tenjin` binary on its own initiative
  finds a public-mode CLI that cannot spend and cannot publish, rather than the operator's shelf.
- **`tenjin`**: the data dir is a copy of the prepared template (config + wallet only; the
  ledger, daemon state and session keys are deliberately not copied, so each session's ledger
  holds only its own fires). Then, with `HOME` pointed at the worktree,
  `tenjin install --harness claude --publish-mode full-auto` writes its hook entries into
  `<worktree>/.claude/settings.json` and its skills into `<worktree>/.claude/skills/` — exactly
  what `--setting-sources project` then loads. One install per session is what makes this real:
  `install` bakes the session's data dir into the shim path and the daemon's url and token, so a
  shared settings file would point every session at one data dir and one daemon.

`TENJIN_DATA_DIR=<sandbox>/tenjin` keeps the CLI's config, wallet, ledger and daemon port per
session (`src/lib/paths.ts`). The operator's `~/.tenjin` is never touched, and neither is their
`~/.claude/settings.json`.

`.claude/` is excluded from the captured diff in both conditions: under `tenjin` it holds
harness scaffolding rather than the agent's work, and excluding it in one condition only would
make the two patches incomparable.

The loop daemon is a long-lived process, so it is stopped explicitly after every `tenjin`
session and again in a `finally`, and `cleanup` sweeps every data dir a run recorded.

## `prepare`, and the config keys it sets

`prepare` reads `tenjin-bench.env` from the workspace root for `TENJIN_BENCH_ORIGIN` and
`TENJIN_BENCH_BYPASS_SECRET`. Neither value is ever printed: both are registered with a redactor
that rewrites them out of every captured stdout, stderr, log line and record before anything is
written or shown.

It builds the template data dir and sets exactly these keys in it:

| key                                              | value                   | why                                                                                                                   |
| ------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                                        | the bench origin        | the team shelf publish, read and the first search leg go to                                                           |
| `shelfBypassSecret`                              | the bench bypass secret | **the one key that turns team mode on**; non-empty is team mode                                                       |
| `team.publicFallback`                            | `off`                   | a team miss must not fall through to tenjin.blog, which would make the funnel unreadable                              |
| `publish.mode`                                   | `full-auto`             | the turn-end capture publishes without a human                                                                        |
| `publish.defaultPrice`                           | `0`                     | bench posts are free, so the consumer side never needs to pay                                                         |
| `publish.ackServerWarnings`                      | `on`                    | a standing yes to the server's warn tier, so a headless run is not blocked by it                                      |
| `maxAutoSpend`, `sessionBudget`, `sendMaxAmount` | `0`                     | the bench must not be able to spend, belt and braces                                                                  |
| `hooks.*` (all seven arms)                       | `true`                  | `prompt` is the injection side and `publish` the capture side; the rest ride along so the funnel shows the whole loop |
| `update.mode`                                    | `off`                   | a daily npm check would be noise in the token counts                                                                  |

It also creates one dedicated **bench wallet** in that data dir. Its passphrase is generated
once and kept 0600 as `bench-wallet-passphrase` beside the keystore, and exported as
`TENJIN_WALLET_PASSPHRASE` for every CLI call — a copied data dir does not carry an OS-keychain
entry with it, so the file is what makes headless signing work in each session. Set
`TENJIN_WALLET_PASSPHRASE` in the environment before `prepare` to supply your own instead.

`prepare` then verifies, and fails loudly rather than silently benchmarking the wrong shelf:

- `baseUrl` equals `TENJIN_BENCH_ORIGIN`
- `shelfBypassSecret` is non-empty (team mode is on)
- `team.publicFallback` is `off`, `publish.mode` is `full-auto`, `publish.defaultPrice` is 0
- the bench wallet exists and its address is recorded
- a live `tenjin search --json` names a shelf leg whose `baseUrl` is the bench origin, names
  no other shelf, and reports no leg error

The verification lands in `<template data dir>/bench-prepare.json`.

## The funnel

After each `tenjin` session the ledger is read straight out of the session's own
`loop.db`, opened `mode=ro&immutable=1` (safe because the daemon is stopped first):

- **fires** — one per hook fire: arm, harness event, wait class, deadline, elapsed, reason,
  whether anything was delivered, and any error. `fires.question` is only the 512-char head the
  daemon stored, so the record names the column `question_head` and nothing treats it as the
  full question.
- **legs** — one per shelf leg of a lookup: stage, shelf, status, outcome, the candidate's
  title/url, and its artifact form.
- **searches** — the search rows: question, decision, source, the shelf base url that answered.
- **facts** rows under `published:` and `agent_published:` — the urls this session actually
  published, which is also what `cleanup` retracts.

The ledger is the ONLY source for what a session published. The CLI has no "list my posts"
verb — its publish group is `publish`, `edit`, `delete`, `profile` and `stats`, and `stats`
returns this month's aggregates rather than rows. So the per-session `published:` facts are
what the report counts, and `cleanup` resolves each url to a post uuid with `tenjin inspect`
because `tenjin delete` takes a uuid and the facts row stores only the url.

The report rolls these into per-session counts: fires by arm, legs by status and outcome,
searches by decision, and posts published.

## Output

```
runs/<id>/
  manifest.json     what was run, with which binaries and flags
  preflight.json    the one-call sandbox/auth/JSON check
  commands.log      every command, rendered, with secrets redacted
  records.jsonl     one JSON record per session
  report.md         the tables
  sessions/<pair>/<condition>/r<n>/<role>/
    record.json     the same record, on its own
    agent-stdout.json
    agent.patch     the agent's diff, kept after the worktree is gone
    funnel.json     tenjin sessions only
```

`report.md` carries per-session medians (tokens split into uncached input, cache-creation,
cache-read and output; wall time; turns; cost; oracle passes), the per-pair A + B totals, the
reuse delta (`tenjin` minus `off`, for B alone and for A + B), the funnel table, and a health
section naming every capped or errored session.

## Flags worth knowing

| flag                                                    | default                            | notes                                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--conditions`                                          | `off,tenjin`                       | comma list                                                                                                                                                                                               |
| `--repeats`                                             | `3`                                | medians are taken across these                                                                                                                                                                           |
| `--sessions`                                            | `producer,consumer`                | run one side only                                                                                                                                                                                        |
| `--only <id>`                                           | all pairs                          | repeatable                                                                                                                                                                                               |
| `--workers N`                                           | `1`                                | **`off` sessions only.** `tenjin` is a chain — B must see what A published — and two loop daemons plus two pnpm installs at once is how a 16 GB laptop swaps to death                                    |
| `--cap-s`                                               | `3600`                             | wall-clock cap per agent session, in seconds. A pair may override it per session with `cap_s` in `pairs.json`. A session that hits the cap is recorded as `capped` and its whole process group is killed |
| `--claude-bin`                                          | `/Users/vraspar/.local/bin/claude` | **the real binary.** The `claude` first on PATH is a cmux shim that makes harness detection pick Codex; the runner says so if they differ                                                                |
| `--permission-mode`                                     | `bypassPermissions`                | the agent must edit files and run pnpm/vitest with nobody to answer a prompt. It is confined by `cwd` (the worktree), not by the permission mode                                                         |
| `--max-budget-usd`                                      | unset                              | per-session API spend cap, passed straight through                                                                                                                                                       |
| `--skip-install` / `--skip-oracle` / `--keep-worktrees` | off                                | debugging                                                                                                                                                                                                |
| `--no-capture-turn`                                     | capture turn on                    | skip the `tenjin` producer's follow-up publish turn                                                                                                                                                      |
| `--capture-cap-s`                                       | `900`                              | wall-clock cap for that follow-up turn                                                                                                                                                                   |
| `--no-preflight`                                        | preflight on                       | the preflight is one tiny real agent call with the exact session flags; it proves the binary, the login under `--setting-sources project`, and the JSON parse before a run spends anything               |
| `--dry-run`                                             | off                                | prints the plan and every command; calls no agent, installs nothing, publishes nothing                                                                                                                   |

## `cleanup`

1. Stops the loop daemon in every data dir the run recorded.
2. **Asserts the configured `baseUrl` is the bench origin, and refuses to delete anything if it
   is not.** Deleting is irreversible and a wrong shelf is the operator's real one.
3. For each recorded published url: `tenjin inspect --json` for the post uuid (free, since bench
   posts are priced 0), then `tenjin delete <uuid> --yes`. A url that is not on the bench origin
   is skipped, never deleted.
4. `--purge-scratch` also removes the run's sandbox directories.

## What this does not do

- It does not run the repo's test suites; only the oracle files a pair names.
- It does not judge the finding's quality. The oracle is pass/fail on the task, and the funnel
  says what the loop delivered; whether the published piece was any good is a separate question.
- It does not touch the operator's shelf, config, wallet, or Claude settings, in either
  condition.
