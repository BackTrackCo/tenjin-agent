You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-412 — support taking a settings override back off an account

Support has no way to undo a settings override. Today `updateSettings` can set a field, and
support can set it back to what the plan says by hand, but the account then carries a frozen
copy of that value for ever: when we move a plan's default, accounts that were "reset" by hand
do not move with it. They need to be able to put a field back under the plan, not on top of it.

Add that, in the domain layer and on the API.

### Interface contract

`src/accounts.ts`

- Export `clearSettingsOverrides(accountId: string, fields: string[]): AccountSettings`.
  - It removes this account's override for each named field, so the field resolves from
    `ORG_OVERRIDES` and `PLAN_DEFAULTS` again.
  - It returns the account's resolved settings after the change, the same shape
    `resolveSettings` returns.
  - Naming a field that has no override is not an error; that field is simply left alone.
  - Naming something that is not a member of `AccountSettings` throws a `LedgerError` whose
    `code` is `invalid_field`.
  - An unknown `accountId` throws the existing `account_not_found` error.

### What must be true of the stored account afterwards

- `getAccount(accountId).overrides` no longer holds the cleared keys, and still holds every key
  that was not named.
- One accepted call bumps `accounts.version` by exactly one, however many fields it cleared, and
  leaves exactly one new row in `settingsVersions` whose `overrides` is the override set as it
  stands after the call.
- An audit event `settings.cleared` is written for an accepted call, with
  `detail.version` set to the new version number and `detail.fields` set to the cleared field
  names, sorted and joined with commas (for example `autoSettle,spendingLimitCents`).

### HTTP

`PATCH /accounts/:accountId/settings` gains a second body shape. It now accepts

```json
{ "set": { "statementDay": 9 }, "reset": ["spendingLimitCents"] }
```

- `set` is an override object, validated as today.
- `reset` is a list of field names to clear.
- Either key may be absent.
- A body that carries neither `set` nor `reset` is still treated as a plain override object, as
  it is today; that path must keep working unchanged.
- One request is one version bump, whether it sets, resets, or does both.
- The 200 response body is `{ settings, version, cleared }`, where `settings` is the resolved
  settings, `version` is the account's version after the call, and `cleared` is the list of
  fields that actually had an override removed, sorted. When nothing was removed, `cleared` is
  an empty array.

### Out of scope

The CLI. Nothing here needs a new command.
