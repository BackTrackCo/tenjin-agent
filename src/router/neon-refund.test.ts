import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// A voucher has no expiry and no nonce, and the highest one above what was claimed is claimable: a
// channel a voucher left unsettled is never deposited into again. It stays on record, and the refund
// reaches it with the salt it was opened with.
it('retires a channel and opens the next with a salt of its own, and refunds both', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const refunded: Array<string | undefined> = [];
  const refunds = new NeonRefunds({
    dataDir: dir,
    payer: (_terms, salt) => ({
      refund: async () => {
        refunded.push(salt);
        return { success: true, amount: '1000' };
      },
    }),
  });
  // EVERY channel has a salt of its own, the first included: nothing depends on a record that can
  // be pruned for the next one to differ.
  const first = await refunds.open('job-a', TERMS);
  expect(first.salt).toMatch(/^0x[0-9a-f]{64}$/);
  const config = {
    payer: '0x00000000000000000000000000000000000000c1',
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  };
  await refunds.saveChannel(TERMS, config);
  await refunds.retire(TERMS);
  const next = await refunds.open('job-a', TERMS);
  expect(next.salt).toMatch(/^0x[0-9a-f]{64}$/);
  await refunds.saveChannel(TERMS, config);
  const entries = await refunds.entries();
  expect(entries).toHaveLength(2);
  const old = entries.find((entry) => entry.retired)!;
  expect(old).toMatchObject({
    jobIds: ['job-a'],
    channel: { ...config, salt: first.salt },
  });
  expect(old.salt).toBe(first.salt);
  expect(next.salt).not.toBe(first.salt);
  expect(entries.find((entry) => !entry.retired)!.channel).toEqual({ ...config, salt: next.salt });
  // The same channel keeps its salt for the jobs that follow.
  expect((await refunds.open('job-b', TERMS)).salt).toBe(next.salt);
  // Both are refunded where the jobs end, each with its own salt.
  await refunds.settle(['job-a', 'job-b'], new AbortController().signal);
  expect(refunded.sort()).toEqual([first.salt, next.salt].sort());
});

// Failure caught by review: a journal over the read limit was read as EMPTY, and the next change
// wrote an empty journal over it, losing the salts and saved configs `tenjin refund` needs. An
// unreadable journal is never empty: nothing is written, the file stays, and the person is told.
it('refuses to write over a journal it cannot read, and keeps the file as it is', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const path = join(dir, 'neon-channels.json');
  const refunds = new NeonRefunds({ dataDir: dir, payer: () => ({ refund: async () => ({}) }) });
  const cases: Array<[string, string]> = [
    [
      'over the size limit',
      JSON.stringify({ version: 1, channels: [], pad: 'x'.repeat(8_100_000) }),
    ],
    ['damaged', '{"version":1,"channels":[{"key"'],
    ['not what this build writes', JSON.stringify({ version: 2, channels: [] })],
  ];
  for (const [, content] of cases) {
    await writeFile(path, content);
    await expect(refunds.open('job-a', TERMS)).rejects.toThrow(/cannot be read/);
    await expect(refunds.retire(TERMS)).rejects.toThrow(/cannot be read/);
    await expect(refunds.entries()).rejects.toThrow(/Nothing was changed/);
    expect(await readFile(path, 'utf8')).toBe(content);
  }
  // Absent is empty, and writes.
  await rm(path);
  expect(await refunds.entries()).toEqual([]);
  await refunds.open('job-a', TERMS);
  expect(await refunds.entries()).toHaveLength(1);
});

// Retired channels do not pile up for ever, and only what is PROVEN finished is forgotten: a chain
// read that shows balance equal to claimed and no withdrawal pending (nothing unclaimed is in it
// and a retired channel is never deposited into again), or a retired entry that never had a
// payment created. Funds, a pending withdrawal or a read that fails keep the entry.
it('prunes a retired channel only on the proof that nothing is left in it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  const refunds = new NeonRefunds({ dataDir: dir, payer: () => ({ refund: async () => ({}) }) });
  const channel = (seed: string) => ({
    payer: '0x00000000000000000000000000000000000000c1',
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    // The delay tells the channels apart in what the chain stub answers.
    withdrawDelay: 900 + Number(seed),
  });
  const seen: Record<string, { balance: bigint; claimed: bigint; pending: bigint } | 'throws'> = {
    '1': { balance: 5_000n, claimed: 5_000n, pending: 0n },
    '2': { balance: 5_000n, claimed: 4_000n, pending: 0n },
    '3': { balance: 5_000n, claimed: 5_000n, pending: 900n },
    '4': 'throws',
  };
  // Four retired channels with a payment behind them, and one that never had one.
  for (const seed of ['1', '2', '3', '4']) {
    await refunds.open(`job-${seed}`, TERMS);
    await refunds.saveChannel(TERMS, channel(seed));
    await refunds.retire(TERMS);
  }
  await refunds.open('job-none', TERMS);
  await refunds.retire(TERMS);
  // One active channel, never retired.
  await refunds.open('job-live', TERMS);
  expect(await refunds.entries()).toHaveLength(6);
  const chain = {
    channel: async (_terms: NeonTerms, saved?: { withdrawDelay: number }) => {
      const answer = seen[String(saved!.withdrawDelay - 900)]!;
      if (answer === 'throws') throw new Error('rpc down');
      return {
        id: '0x',
        balanceAtomic: answer.balance,
        claimedAtomic: answer.claimed,
        pendingAtomic: answer.pending,
        initiatedAt: 0,
        delayS: 900,
        nowS: 0,
      };
    },
    initiate: async () => '0x',
    finalize: async () => '0x',
  };
  expect(await refunds.prune(chain as never)).toBe(2);
  const left = await refunds.entries();
  expect(left).toHaveLength(4);
  // Funds, a pending withdrawal, a failed read and the active channel all stay.
  expect(
    left
      .filter((entry) => entry.retired)
      .map((entry) => String((entry.channel?.withdrawDelay ?? 0) - 900))
      .sort(),
  ).toEqual(['2', '3', '4']);
  expect(left.some((entry) => !entry.retired)).toBe(true);
  // Without a chain, only the entry that never had a payment goes.
  expect(await refunds.prune()).toBe(0);
});

// An empty channel does not prove that a deposit signed for it will not land, and a forgotten entry
// must not let a later channel reuse an earlier identity (an old voucher has no expiry). The entry
// stays until every authorization signed for it has expired and no job of it is live; and whatever
// is pruned, the next channel has a salt that differs from every earlier one.
it('keeps a retired entry while an authorization can still arrive or a job is live, and prunes it after', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-refund-'));
  let clock = 1_000_000;
  let live = true;
  const refunds = new NeonRefunds({
    dataDir: dir,
    now: () => clock,
    live: async () => live,
    payer: () => ({ refund: async () => ({}) }),
  });
  const config = {
    payer: '0x00000000000000000000000000000000000000c1',
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  };
  const empty = {
    channel: async () => ({
      id: '0x',
      balanceAtomic: 7n,
      claimedAtomic: 7n,
      pendingAtomic: 0n,
      initiatedAt: 0,
      delayS: 900,
      nowS: 0,
    }),
    initiate: async () => '0x',
    finalize: async () => '0x',
  };
  const salts: string[] = [];
  salts.push((await refunds.open('job-1', TERMS)).salt!);
  await refunds.saveChannel(TERMS, config);
  // Retired with a deposit authorization that expires at 2,000,000.
  await refunds.retire(TERMS, 2_000_000);
  // The channel reads empty, but the authorization has not expired: kept, with its salt.
  expect(await refunds.prune(empty as never)).toBe(0);
  clock = 2_000_001;
  // Expired, but a job of it is still live: kept.
  expect(await refunds.prune(empty as never)).toBe(0);
  live = false;
  // A read that fails proves nothing: kept.
  const failing = { ...empty, channel: async () => Promise.reject(new Error('rpc down')) };
  expect(await refunds.prune(failing as never)).toBe(0);
  expect((await refunds.entries()).filter((entry) => entry.retired)).toHaveLength(1);
  // Expired, empty, no pending withdrawal, no live job: pruned.
  expect(await refunds.prune(empty as never)).toBe(1);
  expect(await refunds.entries()).toEqual([]);
  // The next channel never reuses an earlier identity, though no record of it is left.
  salts.push((await refunds.open('job-2', TERMS)).salt!);
  await refunds.retire(TERMS, 1);
  await refunds.prune(empty as never);
  salts.push((await refunds.open('job-3', TERMS)).salt!);
  expect(new Set(salts).size).toBe(3);
  expect(salts.every((salt) => /^0x[0-9a-f]{64}$/.test(salt) && !/^0x0+$/.test(salt))).toBe(true);
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
  expect(seen).toEqual([
    { ...config, salt: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    { ...config, salt: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
  ]);
  // A second save does not replace what funded the channel with what a later call saw.
  await refunds.saveChannel(TERMS, {
    ...config,
    receiverAuthorizer: '0x00000000000000000000000000000000000000d2',
  });
  expect((await refunds.entries())[0]!.channel).toEqual({
    ...config,
    salt: expect.stringMatching(/^0x[0-9a-f]{64}$/),
  });
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
