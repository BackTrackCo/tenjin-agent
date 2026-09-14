import { config } from '../config.ts';
import { db } from '../db/queries.ts';
import { runJobs, tallyResults } from '../jobs/runner.ts';
import type { Job } from '../jobs/runner.ts';
import { settleEntry } from '../ledger.ts';
import { daysBetween, nowStamp } from '../time.ts';

/** How many entries the sweeper looked at and what it did with them. */
export interface SweepSummary {
  scanned: number;
  settled: number;
  failed: number;
}

/**
 * Settle everything old enough to settle.
 *
 * The retention window is the operator's, not the caller's: an entry younger
 * than `LEDGER_RETENTION_DAYS` is left alone.
 */
export async function sweepSettled(
  options: { olderThanDays?: number } = {},
): Promise<SweepSummary> {
  const cutoffDays = options.olderThanDays ?? 0;
  const now = nowStamp();

  const pending = db.entries
    .filter((row) => !row.settled)
    .filter((row) => daysBetween(row.createdAtStamp, now) >= cutoffDays);

  const jobs: Job[] = pending.map((row) => ({
    id: `settle:${row.id}`,
    kind: 'settle',
    accountId: row.accountId,
    run: () => {
      settleEntry(row.id);
    },
  }));

  const results = await runJobs(jobs, { retries: 2 });
  const tally = tallyResults(results);

  return {
    scanned: pending.length,
    settled: tally.succeeded ?? 0,
    failed: tally.failed ?? 0,
  };
}

/** The window the sweeper is configured with, for the CLI banner. */
export function sweepWindowDays(): number {
  return config.retentionDays;
}
