import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USDC_ADDRESS } from '../lib/usdc';
import { readSpendSummary } from '../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { BatchSeller, channelDirectory, PayeeMismatch, type SellerTerms } from './neon-seller';

/** The row's terms for the seller stub below. */
const PAYEE = '0x6Be3A763E0FAddAa2f2FCBbaFf60f1A91d49227A';
const TERMS: SellerTerms = {
  url: 'https://seller.example/chat',
  payTo: PAYEE,
  network: 'eip155:8453',
  asset: USDC_ADDRESS,
  scheme: 'batch-settlement',
};

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The seller as a stub: a 402 for the unpaid request, then a reply that names its charge. */
function seller(cost: string | undefined, payTo = PAYEE) {
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
              url: TERMS.url,
              description: '',
              mimeType: 'application/json',
            },
            accepts: [
              {
                scheme: 'batch-settlement',
                network: 'eip155:8453',
                amount: '42521',
                asset: USDC_ADDRESS,
                payTo,
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
    terms: TERMS,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    authorizer,
    requestKey: 'call-1',
    fetchImpl,
  });
  const answer = await batch.post('{}', new AbortController().signal, 1_000_000n);
  expect(answer).toMatchObject({ status: 200, costAtomic: 7321n, ceilingAtomic: 42521n });
  // What a timed withdrawal needs of the channel is kept from the seller's 402, so that recovery
  // never has to ask the seller again.
  expect(answer.channel).toEqual({
    payer: account.address,
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  });
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
    terms: TERMS,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    authorizer,
    requestKey: 'call-1',
    fetchImpl,
  });
  await batch.post('{}', new AbortController().signal, 1_000_000n);
  expect((await readSpendSummary(dir))?.committedAtomic).toBe('42521');
  // The authorizer that admits the next call reads the same window: 42,521 of 60,000 is spent.
  const next = await authorizer.authorize({ amountAtomic: 42_521n, creator: 'seller.example' });
  expect(next.decision).not.toBe('allow');
});

// Failure caught: a seller that names another payee in its live 402 than the row names would be
// paid by the first voucher. Nothing is signed, and the failure says so.
it('signs nothing and sends no voucher when the live 402 names another payee than the row', async () => {
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
  const signed: unknown[] = [];
  const { fetchImpl, paid } = seller('7321', '0x00000000000000000000000000000000DeaDBeef');
  const batch = new BatchSeller({
    dataDir: dir,
    terms: TERMS,
    provider: {
      getSigner: async () => ({
        address: account.address,
        signTypedData: async (message: never) => {
          signed.push(message);
          return account.signTypedData(message);
        },
      }),
    } as never,
    admit: async () => undefined,
    authorizer,
    requestKey: 'call-1',
    fetchImpl,
  });
  await expect(batch.post('{}', new AbortController().signal, 1_000_000n)).rejects.toBeInstanceOf(
    PayeeMismatch,
  );
  expect(signed).toHaveLength(0);
  expect(paid).toHaveLength(0);
  expect(batch.transmitted).toBe(false);
  // Nothing was committed or left reserved.
  const summary = await readSpendSummary(dir);
  expect(summary?.committedAtomic ?? '0').toBe('0');
  expect(summary?.reservations ?? []).toEqual([]);
});

it('keeps each seller and payee in a channel store of its own', () => {
  const here = channelDirectory('/data', TERMS);
  expect(channelDirectory('/data', { ...TERMS, payTo: PAYEE.toLowerCase() })).toBe(here);
  expect(
    channelDirectory('/data', { ...TERMS, payTo: '0x00000000000000000000000000000000000000aa' }),
  ).not.toBe(here);
  expect(channelDirectory('/data', { ...TERMS, url: 'https://other.example/chat' })).not.toBe(here);
});

// Failure caught: the reservation was released and the charge recorded in two writes, so another
// automatic payment could take the room between them, and a failed write after the release was
// swallowed.
it('replaces the reservation with the settled charge in one ledger update, and never swallows a failed write', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const real = createLocalSpendAuthorizer({
    dir,
    policy: {
      maxAutoSpendAtomic: 1_000_000n,
      sessionBudgetAtomic: 5_000_000n,
      allowlistCreators: [],
    },
  });
  const calls: string[] = [];
  const authorizer = {
    ...real,
    authorize: real.authorize,
    release: async (id: string | undefined) => {
      calls.push('release');
      return real.release(id);
    },
    commit: async (...args: Parameters<typeof real.commit>) => {
      calls.push('commit');
      return real.commit(...args);
    },
  };
  const { fetchImpl } = seller('7321');
  const make = (auth: typeof authorizer) =>
    new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      authorizer: auth,
      requestKey: 'call-1',
      fetchImpl,
    });
  await make(authorizer).post('{}', new AbortController().signal, 1_000_000n);
  expect(calls).toEqual(['commit']);
  // A ledger that cannot be written fails the call loudly: nothing is swallowed.
  const broken = {
    ...authorizer,
    commit: async () => {
      throw new Error('disk full');
    },
  };
  await expect(make(broken).post('{}', new AbortController().signal, 1_000_000n)).rejects.toThrow(
    'disk full',
  );
});

// Failure caught by review: the provider request used plain `fetch`, which resolves the name again
// on its own, so a catalog URL that named a private address got the worker's prompt. With no stand-in
// for the network the request goes through the pinned fetch, and a private address is refused before
// anything is signed or sent, for the call and for the refund.
it('refuses a seller whose name resolves to a private address, before anything is signed or sent', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: unknown[] = [];
  const transport = vi.fn();
  const make = () =>
    new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: {
        getSigner: async () => ({
          address: account.address,
          signTypedData: async (message: never) => {
            signed.push(message);
            return account.signTypedData(message);
          },
        }),
      } as never,
      admit: async () => undefined,
      requestKey: 'call-1',
      destination: { resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }] },
      pinnedTransport: transport,
    });
  const batch = make();
  await expect(
    batch.post('{"prompt":"private"}', new AbortController().signal, 1_000_000n),
  ).rejects.toThrow(/private|network address/i);
  expect(batch.transmitted).toBe(false);
  await expect(make().refund(new AbortController().signal)).rejects.toThrow(
    /private|network address/i,
  );
  expect(transport).not.toHaveBeenCalled();
  expect(signed).toHaveLength(0);
});

// Failure caught by review: nothing held the seller's live quote to the room the job has left, so
// removing the bound left every test green. A quote above the room signs nothing and sends nothing.
it('signs nothing when the seller quotes more than the room the job has left', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: unknown[] = [];
  const { fetchImpl, paid } = seller('7321');
  const batch = new BatchSeller({
    dataDir: dir,
    terms: TERMS,
    provider: {
      getSigner: async () => ({
        address: account.address,
        signTypedData: async (message: never) => {
          signed.push(message);
          return account.signTypedData(message);
        },
      }),
    } as never,
    admit: async () => undefined,
    requestKey: 'call-1',
    fetchImpl,
  });
  // The stub's 402 quotes 42,521; the room is 40,000.
  await expect(batch.post('{}', new AbortController().signal, 40_000n)).rejects.toThrow();
  expect(signed).toHaveLength(0);
  expect(paid).toHaveLength(0);
  expect(batch.transmitted).toBe(false);
  // The same quote at exactly the room goes through.
  const fits = new BatchSeller({
    dataDir: dir,
    terms: TERMS,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    requestKey: 'call-2',
    fetchImpl: seller('7321').fetchImpl,
  });
  await expect(fits.post('{}', new AbortController().signal, 42_521n)).resolves.toMatchObject({
    status: 200,
    ceilingAtomic: 42521n,
  });
});

// Failure caught by review: the bound on a refund reached only signing, so a seller that did not
// answer held a finished job's result behind its refund. The signal now reaches the request.
it('ends a refund whose seller never answers when its signal aborts', async () => {
  dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const seen: (AbortSignal | undefined)[] = [];
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      seen.push(init?.signal ?? undefined);
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const batch = new BatchSeller({
    dataDir: dir,
    terms: TERMS,
    provider: { getSigner: async () => account } as never,
    admit: async () => undefined,
    fetchImpl: hanging,
  });
  const stop = new AbortController();
  const refund = batch.refund(stop.signal).then(
    () => 'answered',
    (error: unknown) => String(error),
  );
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toBeDefined();
  stop.abort();
  expect(await refund).toContain('aborted');
});

// Failure caught by review: the payment wrapper posts the whole request to learn the seller's
// terms, so a first call the person's limits then refused had already sent its draft. The unpaid
// request now carries a placeholder of the same size and nothing of the prompt, and the draft goes
// only with a payment that passed the limits.
describe('what the seller sees before a payment exists', () => {
  const PROMPT = 'SECRET-DRAFT-TEXT-THAT-MUST-NOT-LEAK';
  const body = JSON.stringify({
    model: 'test/model',
    max_tokens: 1000,
    messages: [{ role: 'user', content: PROMPT }],
  });
  /** The seller stub, recording the body of every request by whether it carried a payment. */
  function recording(paidStatus = 200) {
    const unpaid: string[] = [];
    const paid: string[] = [];
    const inner = seller('7321');
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input.clone() : new Request(input, init);
      const text = await request.clone().text();
      if (request.headers.has('payment-signature')) {
        paid.push(text);
        return new Response(paidStatus === 200 ? '{"choices":[]}' : 'down', {
          status: paidStatus,
          headers: paidStatus === 200 ? { 'x-request-cost-atomic': '7321' } : {},
        });
      }
      unpaid.push(text);
      return inner.fetchImpl(input, init);
    };
    return { fetchImpl, unpaid, paid };
  }
  const payer = async () => {
    dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
    return privateKeyToAccount(generatePrivateKey());
  };

  it('sends no prompt in the unpaid request, and the whole draft with the payment', async () => {
    const account = await payer();
    const { fetchImpl, unpaid, paid } = recording();
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      fetchImpl,
    });
    await batch.post(body, new AbortController().signal, 1_000_000n);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).not.toContain(PROMPT);
    // Same size and same model and cap, so the seller quotes what the real request is quoted.
    expect(Buffer.byteLength(unpaid[0]!)).toBe(Buffer.byteLength(body));
    expect(JSON.parse(unpaid[0]!)).toMatchObject({ model: 'test/model', max_tokens: 1000 });
    expect(paid).toEqual([body]);
  });

  it('sends none of the prompt at all when the limits refuse the payment', async () => {
    const account = await payer();
    const { fetchImpl, unpaid, paid } = recording();
    const authorizer = createLocalSpendAuthorizer({
      dir,
      policy: {
        maxAutoSpendAtomic: 1_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      },
    });
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      authorizer,
      fetchImpl,
    });
    await expect(batch.post(body, new AbortController().signal, 1_000_000n)).rejects.toThrow();
    expect(paid).toHaveLength(0);
    expect(unpaid.join('')).not.toContain(PROMPT);
    expect(batch.transmitted).toBe(false);
  });

  it('lets a payment the person approved pass their per-call limit, and refuses it otherwise', async () => {
    const account = await payer();
    const run = async (mode: 'automatic' | 'manual') => {
      const { fetchImpl, paid } = recording();
      const batch = new BatchSeller({
        dataDir: dir,
        terms: TERMS,
        provider: { getSigner: async () => account } as never,
        admit: async () => undefined,
        authorizer: createLocalSpendAuthorizer({
          dir,
          policy: {
            maxAutoSpendAtomic: 1_000n,
            sessionBudgetAtomic: null,
            allowlistCreators: [],
          },
        }),
        mode,
        fetchImpl,
      });
      const outcome = await batch
        .post(body, new AbortController().signal, 1_000_000n)
        .then(() => 'paid')
        .catch(() => 'refused');
      return { outcome, paid: paid.length };
    };
    expect(await run('automatic')).toEqual({ outcome: 'refused', paid: 0 });
    expect(await run('manual')).toEqual({ outcome: 'paid', paid: 1 });
  });

  it('sends none of the prompt when the seller names another payee than the row', async () => {
    const account = await payer();
    const other = seller('7321', '0x00000000000000000000000000000000DeaDBeef');
    const unpaid: string[] = [];
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      fetchImpl: async (input, init) => {
        unpaid.push(
          await (input instanceof Request ? input.clone() : new Request(input, init)).text(),
        );
        return other.fetchImpl(input, init);
      },
    });
    await expect(batch.post(body, new AbortController().signal, 1_000_000n)).rejects.toBeInstanceOf(
      PayeeMismatch,
    );
    expect(unpaid.join('')).not.toContain(PROMPT);
  });

  // Failure caught by review: the channel config was kept only after a paid reply succeeded, so a
  // funded first request that got a 503 left a deposit nothing could recover without the seller.
  it('keeps the channel config before the first payment leaves, and also when the paid request fails', async () => {
    const account = await payer();
    const { fetchImpl, paid } = recording(503);
    const order: string[] = [];
    const saved: unknown[] = [];
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      onChannel: async (channel) => {
        order.push(`saved after ${paid.length} paid requests`);
        saved.push(channel);
      },
      fetchImpl,
    });
    const answer = await batch.post(body, new AbortController().signal, 1_000_000n);
    expect(answer.status).toBe(503);
    expect(order).toEqual(['saved after 0 paid requests']);
    expect(saved).toEqual([
      {
        payer: account.address,
        receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
        withdrawDelay: 900,
      },
    ]);
  });

  it('signs nothing when the channel config cannot be kept', async () => {
    const account = await payer();
    const { fetchImpl, paid } = recording();
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      onChannel: async () => {
        throw new Error('disk full');
      },
      fetchImpl,
    });
    await expect(batch.post(body, new AbortController().signal, 1_000_000n)).rejects.toThrow();
    expect(paid).toHaveLength(0);
    expect(batch.transmitted).toBe(false);
  });
});
