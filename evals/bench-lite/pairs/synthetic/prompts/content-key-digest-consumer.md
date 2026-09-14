You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-644 — importing the same file twice doubles the account

Support import a customer's day file by hand. When an import half fails they upload the file
again, and every row that did land the first time lands a second time. Two of the source systems
also emit their columns in whatever order their exporter feels like, and one sends amounts as
strings, so "the same row" is not the same text twice.

Make the import skip rows it has already taken for that account.

### Interface contract

New file `src/commands/import.ts`.

```ts
export interface ImportRow {
  amountCents: number | string;
  kind: EntryKind;
  memo?: string;
  reference?: string;
}

export interface ImportSummary {
  received: number;
  imported: number;
  duplicates: number;
  keys: string[];
}

export function rowKey(accountId: string, row: ImportRow): string;
export function importRows(accountId: string, rows: ImportRow[]): ImportSummary;
```

`rowKey`

- 32 lowercase hex characters, the shape `isKey` in `src/hash.ts` recognises, because it goes in
  the same key column everything else here uses.
- The same row is the same key, whatever order its fields were written in, whether the amount
  came as `250` or `'250'`, and whether an absent `memo` or `reference` was left out or sent
  empty.
- Rows that differ in the account, the amount, the kind, the memo or the reference have
  different keys.

`importRows`

- Posts each row as an entry on the account: `amountCents`, `kind` and `memo` as given, with an
  amount sent as a string meaning that number of cents.
- A row whose key has already been imported **for that account** is skipped: nothing is posted
  and it counts in `duplicates`. The same row for a different account is not a duplicate.
- `received` is how many rows came in, `imported` how many were posted, `duplicates` how many
  were skipped, and `keys` holds the keys of the rows it imported, in the order it imported
  them. A batch where everything was a duplicate has an empty `keys`.
- An unknown `accountId` throws the existing `account_not_found` error.

The store already has somewhere to keep "seen this before" keys: `markKeySeen` and `hasSeenKey`
in `src/db/queries.ts` take a namespace and a key. Use the namespace `'import'`.

### Out of scope

The CLI and the HTTP layer. Reading an actual file: this takes rows that have already been
parsed.
