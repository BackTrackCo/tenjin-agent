You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-631 — a retried post creates a second entry

`POST /entries` is idempotent when the caller sends an `Idempotency-Key`. Two integrations do
not send one, and when their HTTP client retries a request whose response was lost, we post the
entry twice. One customer has been double charged three times this month.

When there is no header, derive the key from what was posted, and tell the caller which of the
two happened.

### Interface contract

`src/ledger.ts`

- Export

  ```ts
  export interface ContentKeyInput {
    accountId: string;
    amountCents: number | string;
    kind: EntryKind;
    memo?: string;
  }

  export function contentKey(input: ContentKeyInput): string;
  ```

- The key is 32 lowercase hex characters, the shape `isKey` in `src/hash.ts` recognises, since
  it goes in the same column as a caller-supplied key.
- Same content, same key. In particular:
  - the order the fields were written in the object makes no difference;
  - an amount given as the string `'700'` keys the same as the number `700`;
  - a missing `memo` keys the same as an empty one.
- Different content, different key: a different account, amount, kind or memo each give a
  different key.

### HTTP

`POST /entries`:

- `amountCents` in the body may be a number or a string of digits; both mean the same amount.
- The key for the request is the `Idempotency-Key` header when there is one, and `contentKey`
  of the posted content when there is not.
- If that key already belongs to an entry on that account, the response is **200** with
  `duplicate: true` and `entry` set to the entry that already exists. Nothing new is stored.
- Otherwise the response is **201** with `duplicate: false` and the entry it created.
- The stored entry's `idempotencyKey` is the header when one was sent, and the derived content
  key when one was not.

### Compatibility

The repository's own tests under `tests/` must still pass unchanged. Run the ones you touch.

### Out of scope

Expiring keys, and idempotency on any other endpoint.
