You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-604 — let ops change configuration without a restart

Every `LEDGER_*` knob we have needs a process restart to take effect, and a restart drops the
in-flight batch. During the March incident ops wanted the batch cap down from 50 to 5 for twenty
minutes and had to choose between the cap and the restart.

Make the configuration re-readable: ops sets the environment variable, tells the process to
reload, and the next piece of work uses the new value.

### Interface contract

`src/config.ts`

- Export `getConfig(): LedgerConfig` — the configuration in force now.
- Export `reloadConfig(): LedgerConfig` — re-read `process.env`, adopt it, and return it.
  - After it returns, `getConfig()` reflects the current environment: a variable that was set
    since the process started, a variable whose value changed, and a variable that has been
    unset since (which goes back to its default).
  - A value that will not parse keeps the default, as it does today.
- `isFlagEnabled(name)` and `describeConfig()` answer from the configuration in force now.
- The existing `config` binding is not part of this contract. Keep it, change it or drop it.

### What has to see a reload

Every one of these reads the configuration when it runs, not when the module was first loaded:

- the batch cap, in `postEntries` and in `POST /entries/batch`. The 400 for an oversized batch
  carries `detail.maxBatchSize` set to the cap in force.
- the currency on a balance, from `balanceFor`.
- the `config` payload on `GET /healthz`.
- `strictAmounts` where `postEntry` normalises an amount, and the retention window the sweeper
  reports.

### Compatibility

The repository's own tests under `tests/` must still pass unchanged. Run the ones you touch.

### Out of scope

A signal handler or an endpoint to trigger the reload; ops will call `reloadConfig()` from the
console. Watching the environment for changes on its own.
