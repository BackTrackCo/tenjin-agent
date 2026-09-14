You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-470 — roll an account's settings back to an earlier version

Every accepted settings write already leaves a row in `settingsVersions` holding the override
set as of that version, and support can read them. They cannot put one back. When a bulk update
goes wrong the only repair is to retype the old values by hand, from a screenshot, and that has
now gone wrong twice.

Give them a revert.

### Interface contract

`src/accounts.ts`

- Export `revertSettings(accountId: string, toVersion: number): AccountSettings`.
  - Afterwards the account's override set is **exactly** the override set recorded at
    `toVersion`: the same keys, with the same values, and no others. A field that was overridden
    after `toVersion` resolves from `ORG_OVERRIDES` and `PLAN_DEFAULTS` again.
  - It returns the account's resolved settings after the change.
  - A revert is itself a write: the account's `version` becomes the version it was at plus one,
    and a new `settingsVersions` row is written holding the restored override set. The rows it
    reverted past stay exactly as they are; nothing is rewritten or deleted.
  - Because the revert is a new version, a second revert can go forwards again, to a version
    number that was written before the first revert.
  - A `toVersion` this account never had throws a `LedgerError` whose `code` is
    `version_not_found` and whose status is 404.
  - An unknown `accountId` throws the existing `account_not_found` error.
  - An audit event `settings.reverted` is written, with `detail.from` set to the version the
    account was at, `detail.to` set to the version asked for, and `detail.version` set to the
    new version number.

### HTTP

Add `POST /accounts/:accountId/settings/revert`.

- Body `{ "toVersion": 2 }`.
- 200 with `{ settings, version, restoredFrom }`: the resolved settings, the account's new
  version number, and the version that was restored from.
- 404 with error code `version_not_found` for a version that is not there.
- 400 for a body with no usable `toVersion` in it.

### Out of scope

The CLI, and any change to how a settings write is recorded. `settingsVersions` already holds
what this needs.
