# Ledgerline

The billing ledger behind Ledgerline. Accounts post entries, entries carry a fee from the
pricing table, and the balance is what is left over.

One process, one in-memory store. The Postgres store lives in the deploy repo and implements the
same `Table` interface, so everything above `src/db/` is the same code either way.

## Layout

| path                 | what is in it                                                  |
| -------------------- | -------------------------------------------------------------- |
| `src/types.ts`       | the domain types every layer shares                            |
| `src/config.ts`      | `LEDGER_*` environment configuration                           |
| `src/context.ts`     | the request scope: request id, buffered audit events           |
| `src/audit.ts`       | the audit trail, written when a scope closes                   |
| `src/merge.ts`       | one-level defaults-plus-override layering                      |
| `src/time.ts`        | the only place storage timestamps and ISO strings meet         |
| `src/hash.ts`        | content hashing for idempotency and dedupe keys                |
| `src/db/`            | row shapes, the table primitive, and the queries built on them |
| `src/accounts.ts`    | accounts, plans, settings resolution                           |
| `src/ledger.ts`      | posting entries and computing balances                         |
| `src/pricing/`       | the pricing rules and the table folded out of them             |
| `src/jobs/runner.ts` | the job runner, with retries                                   |
| `src/http/`          | the route table and the handlers                               |
| `src/commands/`      | what the CLI's subcommands actually do                         |
| `src/cli.ts`         | the CLI entry point                                            |
| `src/testing/`       | helpers for tests, imported by nothing in `src/` proper        |

## Settings

Settings resolve in three layers: the plan defaults in `PLAN_DEFAULTS`, then `ORG_OVERRIDES`,
then whatever the account overrides itself. An account stores only its own layer, so an account
that overrides nothing follows its plan for ever after, including when the plan changes.

Every accepted settings write bumps `accounts.version` and leaves a row in `settingsVersions`
holding the override set as of that version.

## Pricing

`src/pricing/rules.ts` is where prices are written. Rules add up: a plan and entry kind may carry
a flat rule and a percentage rule at once. The service reads the folded table rather than the
rules:

```
pnpm gen:pricing
```

## Idempotency

`POST /entries` takes an `Idempotency-Key` header. When the caller does not send one, hash the
content instead: `fingerprint(payload)` in `src/hash.ts` returns the 32-character key the
`idempotencyKey` column is sized for.

## Running things

```
pnpm install
pnpm test                       # the whole suite
pnpm vitest run tests/ledger.test.ts   # one file
pnpm typecheck
pnpm ledger summary <accountId>
```

Node 24 or newer: the CLI runs the TypeScript sources directly.
