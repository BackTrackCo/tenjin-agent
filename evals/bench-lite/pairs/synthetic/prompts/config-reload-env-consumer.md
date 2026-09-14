You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-620 — settlement v2, behind a flag

The new settlement path is ready to try on real traffic. It goes out behind the `settlement_v2`
feature flag, and ops turn it on and off by editing `LEDGER_FLAGS` on the running process: on
for one customer's account, off the moment anything looks wrong, without waiting for a deploy or
a restart. **Whether the flag is on is decided when the request arrives**, so a request handled
after ops set the variable runs the new path and one handled after they clear it runs the old
one.

### Interface contract

New route `POST /accounts/:accountId/settle`.

- 200, body `{ settled, mode, requestId }`.
  - `settled` is how many of that account's entries this request settled. Entries that were
    already settled are not counted and not touched, so a second call settles `0`.
  - `mode` is `'v2'` when the flag `settlement_v2` is on, and `'v1'` when it is not.
- The flag list is `LEDGER_FLAGS`, comma separated, each entry trimmed. `settlement_v2` counts
  only as a whole entry in that list: `settlement_v2_shadow` is a different flag and does not
  turn this one on.
- An unknown account is a 404 whose error code is `account_not_found`.

### Audit

One settle request records exactly one `settlement.completed` event, with the account id as its
`accountId` and `detail.mode` and `detail.settled` set to what the response reports.

### What the two modes do

For now the two paths settle the same entries, and `mode` is the only visible difference. The
v2 behaviour lands in LED-621; this ticket is the switch, the route and the audit line.

### Out of scope

The CLI. The nightly sweep, which is not flagged.
