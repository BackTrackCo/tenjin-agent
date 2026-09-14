import { beforeEach, describe, expect, it } from 'vitest';
import { readAuditLog } from '../../src/audit.ts';
import { sweepSettled } from '../../src/commands/sweep.ts';
import { runJobs } from '../../src/jobs/runner.ts';
import type { Job } from '../../src/jobs/runner.ts';
import { postEntry } from '../../src/ledger.ts';
import { auditActions, resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

function job(id: string, run: () => void, accountId: string | null = null): Job {
  return { id, kind: 'test', accountId, run };
}

describe('runJobs writes an audit trail', () => {
  it('brackets a job that works', async () => {
    await runJobs([job('one', () => undefined)]);

    expect(auditActions()).toEqual(['job.started', 'job.succeeded']);
    const records = readAuditLog();
    expect(records[0]?.detail).toMatchObject({ jobId: 'one', kind: 'test' });
    expect(records[1]?.detail).toMatchObject({ jobId: 'one', kind: 'test', attempts: 1 });
  });

  it('records the attempts a retried job took', async () => {
    let calls = 0;
    await runJobs(
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

    expect(auditActions()).toEqual(['job.started', 'job.succeeded']);
    expect(readAuditLog()[1]?.detail).toMatchObject({ attempts: 3 });
  });

  it('records a job that gave up, with its last error', async () => {
    await runJobs(
      [
        job('bad', () => {
          throw new Error('boom');
        }),
      ],
      { retries: 1 },
    );

    expect(auditActions()).toEqual(['job.started', 'job.failed']);
    expect(readAuditLog()[1]?.detail).toMatchObject({
      jobId: 'bad',
      attempts: 2,
      error: 'boom',
    });
  });

  it('carries the job account id onto the events', async () => {
    await runJobs([job('one', () => undefined, 'acc_42')]);
    expect(readAuditLog().map((record) => record.accountId)).toEqual(['acc_42', 'acc_42']);
  });

  it('gives each job its own request id, shared by the events of that job', async () => {
    await runJobs([job('one', () => undefined), job('two', () => undefined)]);

    const records = readAuditLog();
    expect(records).toHaveLength(4);
    expect(records[0]?.requestId).toBe(records[1]?.requestId);
    expect(records[2]?.requestId).toBe(records[3]?.requestId);
    expect(records[0]?.requestId).not.toBe(records[2]?.requestId);
  });

  it('writes nothing for a job that was skipped', async () => {
    await runJobs(
      [
        job('bad', () => {
          throw new Error('boom');
        }),
        job('never', () => undefined),
      ],
      { retries: 0, stopOnError: true },
    );

    expect(auditActions()).toEqual(['job.started', 'job.failed']);
  });

  it('keeps what the job itself recorded inside the job', async () => {
    const account = seedAccount('standard');
    postEntry({ accountId: account.id, amountCents: 100, kind: 'debit' });

    await sweepSettled();

    expect(auditActions()).toEqual(['job.started', 'entry.settled', 'job.succeeded']);
    const records = readAuditLog();
    expect(records[1]?.requestId).toBe(records[0]?.requestId);
    expect(records[2]?.requestId).toBe(records[0]?.requestId);
  });

  it('still reports the results it always reported', async () => {
    const results = await runJobs([
      job('one', () => undefined),
      job('bad', () => {
        throw new Error('boom');
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'failed']);
    expect(results.map((result) => result.attempts)).toEqual([1, 2]);
  });
});
