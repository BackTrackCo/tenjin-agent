import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it } from 'vitest';
import { USDC_ADDRESS } from '../lib/usdc';
import { readSpendSummary } from '../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { BatchSeller, recountX402inference, X402INFERENCE_CHAT_URL } from './neon-seller';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The seller as a stub: a 402 for the unpaid request, then a reply that names its charge. */
function seller(cost: string | undefined) {
  const paid: Headers[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Request(input, init).headers;
    if (!headers.has('payment-signature'))
      return new Response('{}', {
        status: 402,
        headers: {
          'payment-required': encodePaymentRequiredHeader({
            x402Version: 2,
            error: 'payment required',
            resource: {
              url: X402INFERENCE_CHAT_URL,
              description: '',
              mimeType: 'application/json',
            },
            accepts: [
              {
                scheme: 'batch-settlement',
                network: 'eip155:8453',
                amount: '42521',
                asset: USDC_ADDRESS,
                payTo: '0x6Be3A763E0FAddAa2f2FCBbaFf60f1A91d49227A',
                maxTimeoutSeconds: 330,
                extra: {
                  name: 'USD Coin',
                  version: '2',
                  receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
                  withdrawDelay: 900,
                },
              },
            ],
          }),
        },
      });
    paid.push(headers);
    return new Response('{"choices":[]}', {
      status: 200,
      headers: cost === undefined ? {} : { 'x-request-cost-atomic': cost },
    });
  };
  return { fetchImpl, paid };
}

it('commits a batch call to the same ledger `tenjin status` and the next authorization read', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const authorizer = createLocalSpendAuthorizer({
    dir,
    policy: {
      maxAutoSpendAtomic: 1_000_000n,
      sessionBudgetAtomic: 5_000_000n,
      allowlistCreators: [],
    },
  });
  const { fetchImpl, paid } = seller('7321');
  const batch = new BatchSeller({
    dataDir: dir,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    authorizer,
    requestKey: 'call-1',
    fetchImpl,
  });
  const answer = await batch.post('{}', new AbortController().signal, 1_000_000n);
  expect(answer).toMatchObject({ status: 200, costAtomic: 7321n, ceilingAtomic: 42521n });
  expect(paid).toHaveLength(1);
  expect(batch.transmitted).toBe(true);
  // What `tenjin status` reads (`readSpendSummary`): the window now holds the real charge.
  const summary = await readSpendSummary(dir);
  expect(summary?.committedAtomic).toBe('7321');
  expect(summary?.reservations).toEqual([]);
});

it('counts a call whose voucher was sent but failed at its ceiling, and the next call sees it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const authorizer = createLocalSpendAuthorizer({
    dir,
    policy: { maxAutoSpendAtomic: 1_000_000n, sessionBudgetAtomic: 60_000n, allowlistCreators: [] },
  });
  // No charge header: the seller never said what it took.
  const { fetchImpl } = seller(undefined);
  const batch = new BatchSeller({
    dataDir: dir,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    authorizer,
    requestKey: 'call-1',
    fetchImpl,
  });
  await batch.post('{}', new AbortController().signal, 1_000_000n);
  expect((await readSpendSummary(dir))?.committedAtomic).toBe('42521');
  // The authorizer that admits the next call reads the same window: 42,521 of 60,000 is spent.
  const next = await authorizer.authorize({ amountAtomic: 42_521n, creator: 'x402inference.com' });
  expect(next.decision).not.toBe('allow');
});

it('recounts earlier x402inference rows into the window once, and never twice', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const authorizer = createLocalSpendAuthorizer({
    dir,
    policy: {
      maxAutoSpendAtomic: 1_000_000n,
      sessionBudgetAtomic: 5_000_000n,
      allowlistCreators: [],
    },
  });
  const row = (ts: string, provider: string, amountAtomic: string) =>
    JSON.stringify({
      version: 1,
      ts,
      capabilityId: 'neon-worker',
      provider,
      url: 'u',
      sent: 's',
      amountAtomic,
      settlement: 'settled',
      savedFiles: [],
    });
  await mkdir(join(dir, 'paid'), { recursive: true });
  await writeFile(
    join(dir, 'paid', 'ledger.jsonl'),
    [
      row('2026-11-23T08:00:00.000Z', 'x402inference.com', '1000'),
      row('2026-11-23T08:30:00.000Z', 'blockrun.ai', '5000'),
      row('2026-11-23T09:30:00.000Z', 'x402inference.com', '7000'),
    ].join('\n') + '\n',
  );
  const now = () => Date.parse('2026-11-23T10:00:00Z');
  expect(await recountX402inference(dir, authorizer, now)).toEqual({ counted: 1, atomic: 1000n });
  expect(await recountX402inference(dir, authorizer, now)).toEqual({ counted: 0, atomic: 0n });
  expect((await readSpendSummary(dir, { now }))?.committedAtomic).toBe('1000');
});
