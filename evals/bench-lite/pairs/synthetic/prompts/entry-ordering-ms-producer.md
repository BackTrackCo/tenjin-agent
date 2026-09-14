You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-518 — entries posted in the same second come back in the wrong order

A customer imports a day's takings in one go. Their statement lists the entries in an order
that is neither the order they were sent nor any order they can explain, and two of them are
stamped as having happened at the same time when they did not.

Reproduced: post three entries one after another and read them back. The order comes out
shuffled, and every entry in the same second carries the same timestamp.

Fix the ordering, and stop the timestamp losing the sub-second part.

### Interface contract

`src/types.ts`

- `Entry` gains `sequence: number`: which entry this is on its account, counting from 1 in the
  order the entries were posted. Each account counts separately.

`src/ledger.ts`

- `listEntries(accountId)` returns entries in the order they were posted, always, including for
  entries posted inside the same second and inside the same millisecond. Oldest first.
- `postEntry` returns the entry it created, now carrying `sequence`.

Timestamps

- `entry.createdAt` is the wall-clock instant the entry was posted, to the millisecond.
  `entry.createdAt.toISOString()` on an entry posted at `2026-03-04T12:00:00.123Z` is exactly
  `'2026-03-04T12:00:00.123Z'`, both from `postEntry` and from `listEntries`.

### HTTP

`GET /accounts/:accountId/entries` and `POST /entries` serve entries in the same shape as today
plus `sequence`, and their `createdAt` string carries the milliseconds.

### Compatibility

- Everything else that reads entries keeps working: the balance, the sweeper's retention window,
  the CLI. The sweeper decides what is old enough with whole days and must go on doing so.
- The existing test files must still pass. Run the ones you touch.

### Out of scope

Paging, filtering, and anything about the order entries are posted in across accounts.
