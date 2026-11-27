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

// Failure caught by the live check at ef6ae364: a refund that found nothing to take back printed the
// amount and transaction of an EARLIER refund beside the state `empty`, so it read as money that had
// just come back. Only a refund that happened now names an amount.
it('names no amount and no transaction on a channel that has nothing to take back', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  let answer: () => Promise<unknown> = async () => ({
    success: true,
    amount: '496440',
    transaction: '0xold',
  });
  const refunds = new NeonRefunds({ dataDir: dir, payer: () => ({ refund: () => answer() }) });
  await refunds.open('job-a', TERMS);
  await refunds.settle(['job-a'], new AbortController().signal);
  expect((await refunds.entries())[0]).toMatchObject({
    state: 'refunded',
    refundedAtomic: '496440',
    transaction: '0xold',
  });
  // The channel is used again, and its next end finds nothing to take back.
  await refunds.open('job-b', TERMS);
  answer = async () => {
    throw new Error('Refund failed: channel has no remaining balance (balance=0)');
  };
  await refunds.settle(['job-b'], new AbortController().signal);
  const [entry] = await refunds.entries();
  expect(entry).toMatchObject({ state: 'empty' });
  expect(entry!.refundedAtomic).toBeUndefined();
  expect(entry!.transaction).toBeUndefined();
});

// Failure caught by review: the timed withdrawal read the channel's receiver authorizer and delay
// from the seller's live 402, so a seller that was offline, or that had changed either, left the
// unused deposit where it was or pointed recovery at another channel. The config is kept from the
// call that funded the channel and handed to the chain steps.
it('hands the saved channel config to every withdrawal step, with no call to the seller', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const config = {
    payer: '0x00000000000000000000000000000000000000c1',
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  };
  const refunds = new NeonRefunds({
    dataDir: dir,
    payer: () => ({
      refund: async () => {
        throw new Error('seller offline');
      },
    }),
  });
  await refunds.open('job-a', TERMS);
  await refunds.saveChannel(TERMS, config);
  const seen: unknown[] = [];
  const chain = {
    channel: async (_terms: NeonTerms, saved: unknown) => {
      seen.push(saved);
      return {
        id: '0xchannel',
        balanceAtomic: 50_000n,
        claimedAtomic: 0n,
        pendingAtomic: 0n,
        initiatedAt: 0,
        delayS: 900,
        nowS: 1_000,
      };
    },
    initiate: async (_terms: NeonTerms, _amount: bigint, saved: unknown) => {
      seen.push(saved);
      return '0xinit';
    },
    finalize: async () => '0xfinal',
  };
  expect(await refunds.retry(chain)).toMatchObject([{ state: 'withdrawal_started' }]);
  expect(seen).toEqual([config, config]);
  // A second save does not replace what funded the channel with what a later call saw.
  await refunds.saveChannel(TERMS, {
    ...config,
    receiverAuthorizer: '0x00000000000000000000000000000000000000d2',
  });
  expect((await refunds.entries())[0]!.channel).toEqual(config);
});

// Failure caught by review: `tenjin refund` skipped the live-job check that a job's end makes, so
// it could refund, and on a failed refund start the on-chain withdrawal of, a channel that a Neon
// job in another session still pays from.
it('leaves a channel alone while a job in another session still runs on it, and takes it once that job is gone', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  let live = true;
  let refunded = 0;
  let touchedChain = 0;
  const refunds = new NeonRefunds({
    dataDir: dir,
    payer: () => ({
      refund: async () => {
        refunded += 1;
        throw new Error('seller offline');
      },
    }),
    live: async () => live,
  });
  await refunds.open('job-a', TERMS);
  const chain = {
    channel: async () => {
      touchedChain += 1;
      throw new Error('should not be read');
    },
    initiate: async () => '0xinit',
    finalize: async () => '0xfinal',
  };
  const waiting = await refunds.retry(chain);
  expect(refunded).toBe(0);
  expect(touchedChain).toBe(0);
  expect(waiting[0]).toMatchObject({
    state: 'open',
    note: expect.stringContaining('still pays from this channel'),
  });
  // Its job ended (or its runner is gone): the same call now asks the seller.
  live = false;
  await refunds.retry({
    ...chain,
    channel: async () => {
      throw new Error('chain read');
    },
  });
  expect(refunded).toBe(1);
});

// Failure caught by review: a slow seller held a finished job's result behind its refund, and the
// refund that gave up was lost. A refund that is cut off is recorded as failed, for `tenjin refund`.
it('ends the job-end refund when its signal aborts, even if the payer ignores it, and keeps it on record', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const refunds = new NeonRefunds({
    dataDir: dir,
    payer: () => ({ refund: () => new Promise(() => undefined) }),
  });
  await refunds.open('job-a', TERMS);
  const stop = new AbortController();
  const done = refunds.settle(['job-a'], stop.signal);
  stop.abort();
  const [entry] = await done;
  expect(entry).toMatchObject({ state: 'failed', note: expect.stringContaining('took too long') });
  // `tenjin refund` asks again, and a seller that answers now is refunded.
  const again = new NeonRefunds({
    dataDir: dir,
    payer: () => ({ refund: async () => ({ success: true, amount: '700' }) }),
  });
  expect((await again.retry())[0]).toMatchObject({ state: 'refunded', refundedAtomic: '700' });
});
