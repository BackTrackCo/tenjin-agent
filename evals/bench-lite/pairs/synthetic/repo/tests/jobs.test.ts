import { beforeEach, describe, expect, it } from 'vitest';
import { sweepSettled } from '../src/commands/sweep.ts';
import { db } from '../src/db/queries.ts';
import { runJobs, tallyResults } from '../src/jobs/runner.ts';
import type { Job } from '../src/jobs/runner.ts';
import { postEntry } from '../src/ledger.ts';
import { resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

function job(id: string, run: () => void): Job {
  return { id, kind: 'test', accountId: null, run };
}

describe('runJobs', () => {
  it('runs every job once when nothing fails', async () => {
    const seen: string[] = [];
    const results = await runJobs([job('a', () => seen.push('a')), job('b', () => seen.push('b'))]);
    expect(seen).toEqual(['a', 'b']);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(results.every((result) => result.attempts === 1)).toBe(true);
  });

  it('retries up to the configured number of extra attempts', async () => {
    let calls = 0;
    const results = await runJobs(
      [
        job('flaky', () => {
          calls += 1;
          if (calls < 3) {
            throw new Error('not yet');
          }
        }),
      ],
      { retries: 2 },
    );
    expect(results[0]).toMatchObject({ status: 'succeeded', attempts: 3, error: null });
  });

  it('gives up and reports the last error', async () => {
    const results = await runJobs([
      job('bad', () => {
        throw new Error('boom');
      }),
    ]);
    expect(results[0]).toMatchObject({ status: 'failed', attempts: 2, error: 'boom' });
  });

  it('skips the rest when stopOnError is set', async () => {
    const results = await runJobs(
      [
        job('bad', () => {
          throw new Error('boom');
        }),
        job('never', () => undefined),
      ],
      { retries: 0, stopOnError: true },
    );
    expect(results.map((result) => result.status)).toEqual(['failed', 'skipped']);
    expect(tallyResults(results)).toMatchObject({ failed: 1, skipped: 1, succeeded: 0 });
  });
});

describe('sweepSettled', () => {
  it('settles the unsettled entries', async () => {
    const account = seedAccount('standard');
    postEntry({ accountId: account.id, amountCents: 100, kind: 'debit' });
    postEntry({ accountId: account.id, amountCents: 200, kind: 'credit' });

    const summary = await sweepSettled();
    expect(summary).toEqual({ scanned: 2, settled: 2, failed: 0 });
    expect(db.entries.all().every((row) => row.settled)).toBe(true);
  });

  it('is a no-op the second time around', async () => {
    const account = seedAccount('standard');
    postEntry({ accountId: account.id, amountCents: 100, kind: 'debit' });
    await sweepSettled();
    expect(await sweepSettled()).toEqual({ scanned: 0, settled: 0, failed: 0 });
  });
});
