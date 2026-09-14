You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-561 — a reconcile command support can run on one account

When a customer disputes a statement, support wants to settle whatever is still open on that
account and hand back the numbers, for one account, now, without waiting for the nightly sweep
to come round to it. They also want the run to be explicable afterwards: which account, how many
entries, what the balance was when it ran.

### Interface contract

New file `src/commands/reconcile.ts`.

- Export

  ```ts
  export interface ReconcileSummary {
    accountId: string;
    checked: number;
    settled: number;
    unsettled: number;
    balanceCents: number;
  }

  export function reconcileAccount(accountId: string): Promise<ReconcileSummary>;
  ```

- `checked` is every entry on the account. `settled` is how many this call settled. `unsettled`
  is how many are still unsettled afterwards. `balanceCents` is the account's balance, the same
  number `balanceFor` gives.
- An unknown `accountId` rejects with the existing `account_not_found` error.

### The audit trail

One reconcile run leaves, in the trail, in this order:

- one `reconcile.started` event,
- one `entry.settled` event per entry it settled (`settleEntry` already records that one),
- one `reconcile.finished` event, with `detail.checked`, `detail.settled` and
  `detail.balanceCents`.

`reconcile.started` and `reconcile.finished` carry the account id as their `accountId`.

**Every event from one run carries the same request id**, the per-entry ones included. A run is
one unit of work in the trail, not a handful of unrelated rows.

### CLI

`ledger reconcile <accountId>`:

- prints exactly
  `reconciled <accountId>: checked <checked>, settled <settled>, balance <balanceCents>`
  and exits 0;
- exits 1 on an unknown account, with the error code on stderr, the way the other commands do;
- exits 2 with no account id, after printing a usage line on stderr;
- is listed in the usage text.

### Out of scope

The HTTP layer. The nightly sweep, which keeps working as it does.
