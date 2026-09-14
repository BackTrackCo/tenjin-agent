# synthetic — six trap pairs on a fixture service

Twelve tasks on one small fictional codebase, built so the thing A has to discover is the thing
B needs and will not be told. Nothing here depends on the tenjin or tenjin-agent checkouts, so a
pair runs the same on any machine and the base never moves under a run.

## Layout

| path                   | what it is                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `repo/`                | the fixture service, as readable files. **This is the copy to edit.**                         |
| `repo.git/`            | a bare mirror of `repo/` holding exactly one commit; the runner cuts worktrees from it        |
| `prompts/`             | the twelve tickets, one file per task                                                         |
| `oracles/<pair>/`      | the hidden tests, copied into the worktree after the agent stops                              |
| `reference/<pair>/`    | reference and naive solutions as patches. **Never inside `repo/`**, so no agent can read them |
| `pairs.json`           | the runner's manifest                                                                         |
| `verify.sh`            | the verification matrix                                                                       |
| `make-fixture-repo.sh` | rebuilds `repo.git` from `repo/` and prints the sha                                           |

`repo.git` exists because a nested `.git` directory cannot be committed: git would record it as
a gitlink and the fixture's files would never land in this repository. A bare mirror is ordinary
files, and `git worktree add --detach` works from it directly.

After editing anything under `repo/`:

```bash
bash evals/bench-lite/pairs/synthetic/make-fixture-repo.sh   # prints the new base sha
# put that sha into pairs.json (twelve places), then re-run verify.sh
```

The commit is made with a fixed identity and date, so the same tree always gives the same sha.
Today that is `f8042b8e46ea61ae7e188aefc03a9b88b354322c`.

## The fixture service

Ledgerline: accounts, settings that resolve through three layers, entries with a fee from a
pricing table, a job runner, an audit trail on a request scope, an HTTP handler layer and a CLI.
Node 24, TypeScript run straight off the sources, vitest, pnpm. About 2,200 lines including its
own 75-test suite, which is green at base and stays green under every reference solution except
where a ticket says otherwise.

`pnpm install --frozen-lockfile --prefer-offline` works offline after one warm install: the
three dev dependencies (vitest 4.1.10, typescript 6.0.3, @types/node 25.9.5) are the versions
already in this machine's pnpm store.

## The six traps

None of them is written down anywhere in the fixture. No comment, no README line, no test.

### 1. `settings-override-clear` — `mergeDefaults` cannot take a key away

`src/merge.ts` skips a key whose override value is `undefined`, which is the usual "do not let
undefined clobber" idiom, and `updateAccountOverrides` in `src/db/queries.ts` is the only write
path for settings. So the obvious way to clear an override, passing `undefined` for it, is a
silent no-op: the write succeeds, the version bumps, and the old value is still there.

- **A (LED-412)** adds `clearSettingsOverrides` and a `reset` list on `PATCH .../settings`. The
  oracle reads the override map back, so an implementation that hands `undefined` to the store
  fails on the first assertion.
- **Naive B (LED-470)** implements revert as "layer the old override set on top of the current
  one". Keys that were added after the target version survive the merge and the account does not
  come back to where it was: 4 of 11 assertions fail.
- Both need the same finding: settings can only be written through a path that replaces the
  override set, not one that layers onto it.

### 2. `entry-ordering-ms` — storage timestamps are whole seconds

`src/time.ts` is the only place storage timestamps and ISO strings meet, and `toStamp` floors to
whole seconds. Entry rows keep `createdAtStamp`, so everything posted inside one second shares a
timestamp, and `listEntryRows` breaks that tie on a content-derived id, which is stable but
arbitrary.

- **A (LED-518)** must return entries in posting order and round-trip `createdAt` to the
  millisecond. 7 of 8 assertions fail at base.
- **Naive B (LED-533)** builds the `since`/`until` window out of `parseStamp`, so both bounds and
  both rows collapse onto the same second and a window inside one second returns everything:
  7 of 11 fail.
- Shared finding: the entry row has to carry milliseconds; the second-resolution column cannot
  answer a sub-second question.

### 3. `job-audit-scope` — no request scope, no audit row

`recordAudit` goes through `withRequestScope`, which returns without running its callback when
there is no ambient scope. The HTTP layer establishes one per request; the job runner and the
CLI do not. So audit calls from a job or a command vanish, with no error and no warning, and a
test helper of the same name re-exported from `src/testing/harness.ts` no-ops the same way,
which makes an agent's own exploratory test pass while proving nothing.

- **A (LED-540)** has to put `job.started` / `job.succeeded` / `job.failed` in the trail, one
  request id per job, with anything the job itself recorded inside it. Adding the `recordAudit`
  calls alone produces an empty trail: 7 of 8 fail.
- **Naive B (LED-561)** writes `reconcile.started` / `reconcile.finished` from a plain async
  function. The summary numbers are right and the CLI works, so 6 assertions pass and the 4 that
  read the trail fail.
- Shared finding: work that is not inside `beginRequest` writes nothing, and the silence is the
  only symptom.

### 4. `pricing-rule-kind` — the table is generated, and the generator drops what it does not know

`src/pricing/index.ts` reads `table.generated.ts`, not `rules.ts`. The vitest global setup runs
`scripts/build-pricing.mjs` before the suite, so a hand edit to the generated file is overwritten
between the edit and the run. The generator folds `flat` and `percent` with two `if`s and no
`else`, so a rule of a new kind is dropped without a word.

- **A (LED-588)** adds a `floor` rule kind. The oracle asserts on `PRICING_TABLE` itself, so
  nothing but a generator that understands the new kind satisfies it: 6 of 10 fail at base.
- **Naive B (LED-596)** adds the `tier` kind to `rules.ts` and applies `cell.tier` in
  `priceFor`, and never touches the generator. The cells come back without a tier, no discount is
  ever applied, and 5 of 9 fail.
- Shared finding: rules are input, the committed table is a build artifact, and the test run
  rebuilds it.

### 5. `config-reload-env` — the environment is read once, at import

`src/config.ts` reads `process.env` while the module is being imported and freezes the result,
and `src/http/handlers.ts` copies the batch cap into a module constant on top of that. Setting an
environment variable after import changes nothing, and nothing says so.

- **A (LED-604)** adds `getConfig` / `reloadConfig` and has to make the batch cap, the currency
  and the health payload follow a reload, the captured constant included. All 11 fail at base.
- **Naive B (LED-620)** gates the new settle route on `isFlagEnabled('settlement_v2')`, which
  reads the frozen snapshot, so the route runs v1 for ever: 4 of 10 fail, and the four are
  exactly the flag ones.
- Shared finding: a per-request read has to go to `process.env` (or through a reload), never to
  the value the module captured at import.

### 6. `content-key-digest` — the documented `fingerprint()` does not exist

`src/hash.ts` documents an example calling `fingerprint(payload)` on an object, and the README's
idempotency section says the same. The module exports `digest(parts, opts)`, which takes an
ordered list of strings and hashes them in that order, so a caller has to build a canonical,
labelled parts list; an object cannot be handed to it at all.

- **A (LED-631)** must derive an idempotency key from the posted content that survives a
  reordered JSON body and an amount sent as a string. All 12 fail at base, starting with the
  import of a function that is not there.
- **Naive B (LED-644)** keys an import row on `JSON.stringify(row)`. Sources that emit their
  columns in another order, or an amount as a string, produce a different key and the same rows
  import twice: 4 of 11 fail.
- Shared finding: there is no `fingerprint`; the key is `digest` over a fixed, labelled parts
  list with amounts normalised first.

## Session-size estimates

Estimates from building the reference solutions by hand, not measurements of an agent.

| pair                      | reference diff      | files touched | expected session |
| ------------------------- | ------------------- | ------------- | ---------------- |
| `settings-override-clear` | A 170 / B 112 lines | 3             | medium           |
| `entry-ordering-ms`       | A 80 / B 95 lines   | 4             | medium           |
| `job-audit-scope`         | A 75 / B 60 lines   | 2             | small            |
| `pricing-rule-kind`       | A 170 / B 165 lines | 4             | medium           |
| `config-reload-env`       | A 120 / B 70 lines  | 5             | medium           |
| `content-key-digest`      | A 115 / B 85 lines  | 2             | small            |

"Small" is a task an agent should finish in a handful of turns once it has found the trap;
"medium" adds a second surface (the HTTP layer, the generator) to keep in step. The trap is the
variance, not the size: every one of these is a short diff that is unreachable until the agent
works out why its first, reasonable attempt did nothing.

## Leak check

`grep -nicE` over both prompts of each pair, for the words that would give the trap away:

| pair                      | terms                                                            | hits           |
| ------------------------- | ---------------------------------------------------------------- | -------------- |
| `settings-override-clear` | `mergeDefaults`, `undefined`, `merge`, `delete`                  | 0 / 0          |
| `entry-ordering-ms`       | `toStamp`, `fromStamp`, `createdAtStamp`, `truncat`              | 0 / 0          |
| `job-audit-scope`         | `withRequestScope`, `beginRequest`, `AsyncLocalStorage`, `scope` | 1 / 1 (benign) |
| `pricing-rule-kind`       | `build-pricing`, `globalSetup`, `regenerat`, `generator`         | 1 / 1 (benign) |
| `config-reload-env`       | `reloadConfig`, `getConfig`, `module`, `snapshot`, `cache`       | 0 (consumer)   |
| `content-key-digest`      | `fingerprint`, `digest`                                          | 0 / 0          |

The two benign hits: `scope` matches the "Out of scope" heading both prompts carry, and
`generate` matches the path `src/pricing/table.generated.ts`, which is part of the interface
contract. Neither says anything about the trap. `trap`, `gotcha`, `beware` and `silently` are 0
across all twelve.

The producer prompt for `config-reload-env` does say a value must be read when the work runs
rather than when the module loaded, because that is the ticket. Its consumer says only that the
flag is decided when the request arrives, which is the requirement, not the mechanism.

## Verification

```bash
bash evals/bench-lite/pairs/synthetic/verify.sh                 # all six
bash evals/bench-lite/pairs/synthetic/verify.sh job-audit-scope # one
```

Per pair it cuts five throwaway worktrees from `repo.git`, installs offline, applies a patch
where there is one, copies the oracle in and runs that one file, then removes the worktree.
Thirty cases, roughly two minutes, no servers and no whole-suite runs.

Last run, at `f8042b8`: **30 of 30 as expected** — every producer fails at base and passes with
its reference, every consumer fails at base, fails naive, and passes with its reference.

## Running it

```bash
python3 evals/bench-lite/run.py --pairs evals/bench-lite/pairs/synthetic/pairs.json \
    --conditions off,tenjin --repeats 1 --out runs/synthetic-1 --dry-run
```

`pairs.json` points `repo` at `repo.git`, a package-relative path rather than one of the two
named checkouts; `resolve_checkout` in `run.py` takes either. The oracle command names its one
file, so the runner's whole-suite refusal never fires.
