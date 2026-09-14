You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-533 — a time window on the entries endpoint

Two customers are polling `GET /accounts/:id/entries` every few seconds and paying us to send
them their whole history each time. They want to ask for the entries since the last one they
saw. Their poll interval is under a second, so "since" has to mean the instant they name, not
the second it falls in: an entry they have already seen must never come back, and one they have
not must never be skipped.

### Interface contract

`src/ledger.ts`

- Export `listEntriesInWindow(accountId: string, window: { since?: string; until?: string }): Entry[]`.
  - `since` and `until` are ISO-8601 instants with milliseconds, for example
    `'2026-03-04T12:00:00.500Z'`.
  - `since` is inclusive: an entry posted at exactly `since` is in the window.
  - `until` is exclusive: an entry posted at exactly `until` is not.
  - The comparison is to the millisecond. Two entries posted in the same second, one before the
    bound and one after it, land on opposite sides of it.
  - Either bound may be left out, meaning unbounded on that side. With neither, the result is
    every entry on the account.
  - The result is oldest first.
  - A bound that is not an ISO-8601 instant, the empty string included, throws a `LedgerError`
    whose `code` is `invalid_window` and whose status is 400.
  - An unknown `accountId` throws the existing `account_not_found` error.

### HTTP

`GET /accounts/:accountId/entries` takes `since` and `until` on the query string, with the same
meaning. Its 200 body gains `count`, the number of entries in `entries`. With no query string it
serves the whole account, as it does today, with `count` alongside.

A bad bound is a 400 whose error code is `invalid_window`.

### Notes

The request object the handlers take already carries `query`; the router does not need to
change for this.

### Out of scope

Paging and cursors. This is a filter, not a pager.
