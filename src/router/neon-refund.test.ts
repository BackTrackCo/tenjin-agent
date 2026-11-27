import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NeonRefunds } from './neon-refund';
import type { NeonTerms } from './neon-terms';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const TERMS: NeonTerms = {
  rowId: 'row-1',
  label: 'Test Writer',
  url: 'https://seller.example/chat',
  payTo: '0x00000000000000000000000000000000000000aa',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  inputAtomicPerMillion: '3150000',
  outputAtomicPerMillion: '15750000',
  cacheReadAtomicPerMillion: '157500',
};

// Failure caught by review: `settle` refunded outside the journal's lock and then wrote its result.
// A second job that opened the channel while that refund was in flight, and deposited after it,
// had its `open` state overwritten with `refunded`, so its own end and `tenjin refund` skipped the
// money it had put in.
it('keeps a channel open when another job used it while its refund was in flight', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  let calls = 0;
  const refunds: NeonRefunds = new NeonRefunds({
    dataDir: dir,
    payer: () => ({
      refund: async () => {
        calls += 1;
        // The first refund is in flight when the second job opens the channel and deposits.
        if (calls === 1) await refunds.open('job-b', TERMS);
        return { success: true, amount: '1000' };
      },
    }),
  });
  await refunds.open('job-a', TERMS);
  await refunds.settle(['job-a'], new AbortController().signal);
  const [entry] = await refunds.entries();
  // The old refund must not close a channel a newer job opened: it stays open for the new money.
  expect(entry).toMatchObject({ state: 'open', jobIds: ['job-a', 'job-b'] });
  // The second job's own end refunds what it put in, and `tenjin refund` would too.
  await refunds.settle(['job-b'], new AbortController().signal);
  expect(calls).toBe(2);
  expect((await refunds.entries())[0]).toMatchObject({ state: 'refunded' });
});

it('records a refund that nothing disturbed, and a retry of an open channel the same way', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const refunds = new NeonRefunds({
    dataDir: dir,
    payer: () => ({ refund: async () => ({ success: true, amount: '500' }) }),
  });
  await refunds.open('job-a', TERMS);
  await refunds.settle(['job-a'], new AbortController().signal);
  expect((await refunds.entries())[0]).toMatchObject({ state: 'refunded', refundedAtomic: '500' });
});
