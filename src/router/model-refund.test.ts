import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import {
  computeChannelId,
  createBatchSettlementEIP3009DepositPayload,
  signVoucher,
} from '@x402/evm/batch-settlement/client';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypedDataDefinition } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { withHeldLock } from '../lib/held-lock';
import { holder, killChildren } from '../lib/held-lock-test/child';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { SIWX_HEADER } from '../lib/siwx';
import { MISMATCH, TEST_POLICY, testSigner } from './fee-test-utils';
import { legacySharedInferenceChannel, modelInferenceRunScope } from './model-channel';
import {
  ModelRefundJournal,
  hasModelRefundRecords,
  modelRefundRunLock,
  readModelRefundResult,
  readModelRefundSummary,
  readModelRefundNote,
} from './model-refund';

const origin = 'https://router.test';
const url = origin + '/api/model-proxy/messages';
const network = 'eip155:8453';
const transaction = `0x${'9'.repeat(64)}` as const;
const requirements: PaymentRequirements = {
  scheme: 'batch-settlement',
  network,
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  payTo: '0x1111111111111111111111111111111111111111',
  amount: '300',
  maxTimeoutSeconds: 60,
  extra: {
    receiverAuthorizer: '0x2222222222222222222222222222222222222222',
    withdrawDelay: 108_000,
    name: 'USD Coin',
    version: '2',
  },
};
const dirs: string[] = [];
afterEach(async () => {
  killChildren();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function challenge(
  quote: PaymentRequirements = { ...requirements, amount: '0' },
  enabled = true,
  error?: string,
) {
  const headers = new Headers({
    'payment-required': encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url },
      accepts: [quote],
      ...(error ? { error } : {}),
    }),
  });
  if (enabled) headers.set('tenjin-inference-refunds', 'worker-v1');
  return new Response(null, { status: 402, headers });
}

async function fixture(shared?: 0 | 1) {
  const dataDir = await mkdtemp(join(tmpdir(), 'model-refund-'));
  dirs.push(dataDir);
  const runId = randomUUID();
  await mkdir(join(dataDir, 'model-jobs'), { recursive: true });
  const signer = testSigner();
  const sdk = toClientEvmSigner({
    address: signer.address,
    signTypedData: (args) => signer.signTypedData(args as unknown as TypedDataDefinition),
  });
  const channelConfig = {
    payer: signer.address,
    payerAuthorizer: signer.address,
    receiver: requirements.payTo as `0x${string}`,
    receiverAuthorizer: requirements.extra.receiverAuthorizer as `0x${string}`,
    token: requirements.asset as `0x${string}`,
    withdrawDelay: requirements.extra.withdrawDelay as number,
    salt:
      shared === undefined
        ? modelInferenceRunScope(origin, runId).salt
        : legacySharedInferenceChannel(origin, shared).salt,
  };
  const channelId = computeChannelId(channelConfig, network);
  const signed = await createBatchSettlementEIP3009DepositPayload(
    sdk,
    2,
    requirements,
    channelConfig,
    '1000',
    '300',
  );
  const signature = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: requirements,
    payload: signed.payload,
  });
  const state = {
    balance: 1000n,
    claimed: 300n,
    spent: true,
    timestamp: 1n,
    chainId: 8453,
    next: 'normal' as 'normal' | 'drop' | 'stale' | 'wrong_receipt' | 'corrective',
    probe: () => challenge(),
  };
  const nonces: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(input).toBe(url);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    const refund = headers.get('payment-signature');
    const auth = headers.get(SIWX_HEADER);
    if (refund === null) {
      expect(auth).toBeNull();
      return state.probe();
    }
    const request = decodePaymentSignatureHeader(refund);
    expect(request.accepted.amount).toBe('0');
    expect(request.payload.type).toBe('refund');
    expect(request.payload.amount).toBeUndefined();
    expect(request.payload.voucher).toMatchObject({
      channelId,
      maxClaimableAmount: state.claimed.toString(),
    });
    const proof = parseSIWxHeader(auth!);
    expect(proof).toMatchObject({
      address: signer.address,
      domain: new URL(origin).host,
      chainId: network,
    });
    nonces.push(String(proof?.nonce));
    if (state.next === 'corrective' && nonces.length === 1) {
      state.claimed = 400n;
      const voucher = await signVoucher(sdk, channelId, '400', network);
      return challenge(
        {
          ...requirements,
          amount: '0',
          extra: {
            ...requirements.extra,
            channelState: { chargedCumulativeAmount: '400' },
            voucherState: { signedMaxClaimable: '400', signature: voucher.signature },
          },
        },
        true,
        MISMATCH,
      );
    }
    if (state.next !== 'stale') state.balance = state.claimed;
    if (state.next === 'drop') throw new Error('response lost after settlement');
    return new Response(null, {
      headers: {
        'payment-response': encodePaymentResponseHeader({
          success: true,
          payer: signer.address,
          network,
          transaction,
          amount: state.next === 'wrong_receipt' ? '1000' : (1000n - state.claimed).toString(),
          extra: {
            channelState: {
              channelId,
              balance: state.claimed.toString(),
              totalClaimed: state.claimed.toString(),
            },
          },
        }),
      },
    });
  });
  const newJournal = () =>
    new ModelRefundJournal(dataDir, origin, {
      getSigner: async () => signer,
      readChainId: async () => state.chainId,
      readBlockTimestamp: async () => state.timestamp,
      readContract: async (args) => {
        if (args.functionName === 'authorizationState') {
          expect(args.address).toBe(requirements.asset);
          return state.spent;
        }
        expect(args.functionName).toBe('channels');
        expect(args.args).toEqual([channelId]);
        return [state.balance, state.claimed];
      },
      fetchImpl,
    });
  const journal = newJournal();
  return {
    newJournal,
    dataDir,
    runId,
    signer,
    signature,
    channelId,
    state,
    journal,
    fetchImpl,
    nonces,
    record: () =>
      withHeldLock(modelRefundRunLock(dataDir, origin, runId), () =>
        journal.record(runId, url, signature),
      ),
  };
}

it('journals only channel metadata and refunds the unspent amount with the pinned SDK', async () => {
  const { dataDir, runId, signer, channelId, signature, record, journal, fetchImpl } =
    await fixture();
  await record();
  await record();
  const [filename] = await readdir(join(dataDir, 'model-refunds'));
  const contents = await readFile(join(dataDir, 'model-refunds', filename!), 'utf8');
  expect(contents).not.toContain(signature);
  expect(contents).not.toContain('signature');
  expect(JSON.parse(contents)).toMatchObject({
    runId,
    url,
    channelId,
    funding: [expect.anything()],
  });
  expect(await hasModelRefundRecords(dataDir)).toBe(true);
  const result = { state: 'refunded', amountAtomic: '700', transaction };
  await expect(journal.close(runId)).resolves.toEqual(result);
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual(result);
  await expect(readModelRefundSummary(dataDir, origin, signer.address)).resolves.toEqual({
    pending: 0,
    refundedAtomic: '700',
    pendingElsewhere: [],
  });
  await expect(
    readModelRefundSummary(dataDir, 'https://different.test', signer.address),
  ).resolves.toEqual({
    pending: 0,
    refundedAtomic: '0',
    pendingElsewhere: [],
  });
  await journal.recoverPending();
  await expect(journal.close(runId)).resolves.toEqual(result);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(await hasModelRefundRecords(dataDir)).toBe(false);
  await expect(record()).rejects.toThrow('already sealed');
});

it('skips a live run, and later refuses a changed router identity', async () => {
  const { dataDir, runId, record, state, journal, fetchImpl } = await fixture();
  await record();
  await withHeldLock(modelRefundRunLock(dataDir, origin, runId), async () => {
    await journal.recoverPending();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  state.probe = () => challenge({ ...requirements, amount: '0', payTo: requirements.asset });
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

// A refund that waits says why, with its record, so a pending one is not a mystery.
it('keeps the reason a pending refund could not close with its record', async () => {
  const { dataDir, runId, record, state, journal } = await fixture();
  await record();
  state.probe = () => challenge({ ...requirements, amount: '0', payTo: requirements.asset });
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  const dir = join(dataDir, 'model-refunds');
  const files = (await readdir(dir)).sort();
  expect(files).toHaveLength(2);
  const note = await readFile(join(dir, files[1]!), 'utf8');
  expect(files[1]).toMatch(/\.note$/);
  expect(note).toMatch(/^(failed: |waiting|deposit|no chain|another)/);
  expect((await stat(join(dir, files[1]!))).mode & 0o777).toBe(0o600);
  // The record itself carries no note.
  expect(JSON.parse(await readFile(join(dir, files[0]!), 'utf8'))).not.toHaveProperty('note');
  await expect(readModelRefundNote(dataDir, origin, runId)).resolves.toBe(note);
});

// A session that timed out on the lock only writes the side note: the record stays byte for
// byte what the lock holder saved, even when that session read it before the holder's write.
it('leaves the record byte-identical and writes no note when a recovery could not take the lock', async () => {
  const { dataDir, runId, record, journal } = await fixture();
  await record();
  const dir = join(dataDir, 'model-refunds');
  const [file] = await readdir(dir);
  const before = await readFile(join(dir, file!), 'utf8');
  await withHeldLock(modelRefundRunLock(dataDir, origin, runId), async () => {
    await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  });
  expect(await readFile(join(dir, file!), 'utf8')).toBe(before);
  // A lock timeout is a live run: no note, and so no advice to remove the lock directory.
  await expect(readModelRefundNote(dataDir, origin, runId)).resolves.toBeUndefined();
  expect(await readdir(dir)).toEqual([file]);
});

// After a base URL change `tenjin balance` showed nothing of these. A refund request carries
// a wallet proof, so one for a router the person no longer configured is counted, not sent.
it('counts a pending refund recorded for an earlier router origin, and sends that router nothing', async () => {
  const { dataDir, record, signer, fetchImpl } = await fixture();
  await record();
  const moved = 'https://moved.test';
  await expect(readModelRefundSummary(dataDir, moved, signer.address)).resolves.toEqual({
    pending: 0,
    refundedAtomic: '0',
    pendingElsewhere: [{ origin, pending: 1 }],
  });
  await new ModelRefundJournal(dataDir, moved, {
    getSigner: async () => signer,
    fetchImpl,
  }).recoverPending();
  expect(fetchImpl).not.toHaveBeenCalled();
});

// The run lock is held by the process that runs the worker and ends with it, at whatever line it
// dies: recovery leaves a live run alone and settles one whose process is gone.
it('leaves a run alone while another process holds its run lock, and refunds it once that process is killed', async () => {
  const { dataDir, runId, record, newJournal, fetchImpl } = await fixture();
  await record();
  const run = await holder(modelRefundRunLock(dataDir, origin, runId));
  await newJournal().recoverPending();
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual({
    state: 'pending',
  });
  await run.kill();
  await newJournal().recoverPending();
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual({
    state: 'refunded',
    amountAtomic: '700',
    transaction,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('waits for a live funding authorization and refuses a different RPC chain', async () => {
  const { runId, record, state, journal, fetchImpl } = await fixture();
  await record();
  state.balance = 0n;
  state.claimed = 0n;
  state.spent = false;
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  state.timestamp = BigInt(Math.floor(Date.now() / 1000) + 600);
  state.chainId = 84532;
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  state.chainId = 8453;
  await expect(journal.close(runId)).resolves.toEqual({ state: 'no_balance' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('uses on-chain settlement to close after a dropped response and does not submit twice', async () => {
  const { dataDir, runId, record, state, journal, fetchImpl } = await fixture();
  await record();
  state.next = 'drop';
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  await journal.recoverPending();
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual({ state: 'closed' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('keeps a submitted receipt pending until on-chain reconciliation', async () => {
  const { dataDir, runId, record, state, journal, fetchImpl } = await fixture();
  await record();
  state.next = 'stale';
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  state.balance = state.claimed;
  await journal.recoverPending();
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual({
    state: 'refunded',
    amountAtomic: '700',
    transaction,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

/** Counts one sent authorization in the daily budget, as the payer does for a deposit. */
async function count(dataDir: string, nonce: string, amountAtomic: bigint) {
  const authorizer = createLocalSpendAuthorizer({ dir: dataDir, policy: TEST_POLICY });
  const auth = await authorizer.authorize({ amountAtomic, creator: 'router.test' });
  await authorizer.commit(auth.reservationId, amountAtomic, { nonce });
}
const counted = async (dataDir: string) => spentOf((await readSpendSummary(dataDir))!);
const runDeposit = (runId: string) =>
  `routing-deposit:run:${modelInferenceRunScope(origin, runId).id}:first`;

// Each run's first deposit counted toward the daily budget and nothing gave its refund
// back: about twenty cheap runs used up a $5 day though most of the money had returned.
it('gives a confirmed refund back to the daily budget, once, and never a pending one', async () => {
  const { dataDir, runId, record, state, journal, newJournal } = await fixture();
  await record();
  await count(dataDir, runDeposit(runId), 1000n);
  await count(dataDir, 'routing-deposit:another', 400n);
  state.next = 'stale';
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  expect(await counted(dataDir)).toBe(1400n);
  state.balance = state.claimed;
  await journal.recoverPending();
  // The run cost 300 of its 1000 deposit: 700 came back, and the other spend stays.
  expect(await counted(dataDir)).toBe(700n);
  // A restart reads the same record and ledger, and gives nothing back twice.
  await newJournal().recoverPending();
  await expect(newJournal().close(runId)).resolves.toMatchObject({ state: 'refunded' });
  expect(await counted(dataDir)).toBe(700n);
});

it("gives back no more than the run's own deposits still count, and nothing once the window rolled", async () => {
  const { dataDir, runId, record, journal } = await fixture();
  await record();
  // The run deposited 1000, of which this window counted 500. The refund is 700.
  await count(dataDir, runDeposit(runId), 500n);
  await count(dataDir, 'routing-deposit:another', 400n);
  await expect(journal.close(runId)).resolves.toMatchObject({ state: 'refunded' });
  expect(await counted(dataDir)).toBe(400n);

  const later = await fixture();
  await later.record();
  await count(later.dataDir, runDeposit(later.runId), 1000n);
  const day = 86_400_000;
  const rolled = new ModelRefundJournal(later.dataDir, origin, {
    getSigner: async () => later.signer,
    readChainId: async () => 8453,
    readBlockTimestamp: async () => 1n,
    readContract: async (args) =>
      args.functionName === 'authorizationState'
        ? true
        : [later.state.balance, later.state.claimed],
    fetchImpl: later.fetchImpl,
    now: () => Date.now() + day,
  });
  await expect(rolled.close(later.runId)).resolves.toMatchObject({ state: 'refunded' });
  expect(spentOf((await readSpendSummary(later.dataDir))!)).toBe(1000n);
});

it('does not report a discrepant refund receipt as verified', async () => {
  const { dataDir, runId, signer, record, state, journal } = await fixture();
  await record();
  state.next = 'wrong_receipt';
  await expect(journal.close(runId)).resolves.toEqual({ state: 'pending' });
  await journal.recoverPending();
  await expect(readModelRefundResult(dataDir, origin, runId)).resolves.toEqual({ state: 'closed' });
  await expect(readModelRefundSummary(dataDir, origin, signer.address)).resolves.toEqual({
    pending: 0,
    refundedAtomic: '0',
    pendingElsewhere: [],
  });
});

it('lets the SDK correct a stale voucher once under a new wallet proof', async () => {
  const { runId, record, state, journal, nonces, fetchImpl } = await fixture();
  await record();
  state.next = 'corrective';
  await expect(journal.close(runId)).resolves.toEqual({
    state: 'refunded',
    amountAtomic: '600',
    transaction,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(nonces).toHaveLength(2);
  expect(nonces[0]).not.toBe(nonces[1]);
});

// Earlier dev builds parked credit in two shared channels that nothing refunded. A one-time
// action refunds each through the run-channel refund, once.
const parkLegacyCredit = async (f: Awaited<ReturnType<typeof fixture>>, slot: 0 | 1) => {
  const { FileClientChannelStorage } =
    await import('@x402/evm/batch-settlement/client/file-storage');
  const { payerDir } = await import('./fee');
  const directory = join(
    payerDir(f.dataDir, f.signer.address),
    'model-inference',
    legacySharedInferenceChannel(origin, slot).id,
  );
  await new FileClientChannelStorage({ directory }).set(f.channelId, {
    balance: '1000',
    chargedCumulativeAmount: '300',
  });
  return directory;
};

it('refunds the credit parked in an old shared channel once, and a second run finds nothing', async () => {
  const f = await fixture(0);
  const directory = await parkLegacyCredit(f, 0);
  const first = await f.journal.reclaimSharedCredit();
  expect(first).toEqual([
    {
      slot: 0,
      channelId: f.channelId,
      result: { state: 'refunded', amountAtomic: '700', transaction },
    },
  ]);
  const paidRequests = f.fetchImpl.mock.calls.length;
  expect(await f.newJournal().reclaimSharedCredit()).toEqual([]);
  expect(f.fetchImpl.mock.calls.length).toBe(paidRequests);
  // The recovery never runs as a background pass.
  await f.journal.recoverPending();
  expect(directory).toContain('model-inference');
});

it('finds nothing parked and asks the router nothing', async () => {
  const f = await fixture(0);
  expect(await f.journal.reclaimSharedCredit()).toEqual([]);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

it('leaves the old channel and the journal unchanged when the router gives no refund challenge', async () => {
  const f = await fixture(1);
  const directory = await parkLegacyCredit(f, 1);
  const before = await readFile(join(directory, 'client', `${f.channelId}.json`), 'utf8');
  f.state.probe = () => new Response(null, { status: 500 });
  await expect(f.journal.reclaimSharedCredit()).rejects.toThrow(
    /did not provide an inference refund challenge/,
  );
  expect(await readFile(join(directory, 'client', `${f.channelId}.json`), 'utf8')).toBe(before);
  await expect(readdir(join(f.dataDir, 'model-refunds'))).rejects.toMatchObject({ code: 'ENOENT' });
});
