You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-540 — the job runner leaves no audit trail

Every HTTP request this service handles ends up in the audit trail, and support can pull the
whole story of a request out of it by request id. Work the job runner does is invisible: the
nightly sweep settles entries and there is nothing afterwards that says which jobs ran, which
ones were retried, or which ones gave up. The last incident took two hours because of it.

Put the jobs in the trail.

### Interface contract

`src/jobs/runner.ts`

Every job the runner actually runs writes audit events:

- `job.started`, before the first attempt, with `detail.jobId` and `detail.kind`.
- then exactly one of
  - `job.succeeded`, with `detail.jobId`, `detail.kind` and `detail.attempts`, the number of
    attempts the job took including the one that worked;
  - `job.failed`, with `detail.jobId`, `detail.kind`, `detail.attempts` and `detail.error`, the
    message of the last error.
- Each event's `accountId` is the job's own `accountId`.
- A job that was skipped, because an earlier job failed under `stopOnError`, writes nothing at
  all.

Request ids

- The events of one job share one request id.
- Two different jobs have two different request ids.
- Anything the job's own `run()` records goes in the trail under that job's request id, between
  that job's `job.started` and its `job.succeeded` or `job.failed`. `sweepSettled` settles
  entries through the runner, and `settleEntry` records `entry.settled`, so a sweep of one entry
  leaves `job.started`, `entry.settled`, `job.succeeded`, all under one request id.

What must not change

- `runJobs` returns the same `JobResult[]` it returns today: same order, same `status`,
  `attempts` and `error` values, same retry and `stopOnError` behaviour.
- `sweepSettled` returns the same `SweepSummary`.
- The existing test files must still pass. Run the ones you touch.

### Out of scope

The HTTP layer, which already records what it does, and any new job kind.
