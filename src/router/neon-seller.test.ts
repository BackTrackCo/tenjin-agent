import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USDC_ADDRESS } from '../lib/usdc';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
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
function seller(cost: string | undefined, payTo = PAYEE, amount = '42521') {
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
                amount,
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
describe('what the seller quotes and accepts', () => {
  const PROMPT = 'SECRET-DRAFT-TEXT-THAT-MUST-NOT-LEAK';
  const body = JSON.stringify({
    model: 'test/model',
    max_tokens: 1000,
    messages: [{ role: 'user', content: PROMPT }],
  });
  /**
   * The seller stub, as the real one behaves (x402inference.com, read with unpaid requests): the
   * ceiling it quotes is priced from the request's own content, and a payment is accepted only
   * where its `accepted.amount` equals the price of the body that carries it. Any other payment
   * is answered 402 "payment was not accepted", as x402's server does (`accepted` is compared with
   * the offer field by field, the amount included).
   */
  const priceOf = (text: string) =>
    String(
      40_000 +
        Buffer.byteLength(text) +
        // Content counts, not only size: a body of filler is never priced like the draft.
        [...text].reduce((sum, char) => sum + (char.charCodeAt(0) % 7), 0),
    );
  function recording(paidStatus = 200, hold?: Promise<void>) {
    const unpaid: string[] = [];
    const paid: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input.clone() : new Request(input, init);
      const text = await request.clone().text();
      const signature = request.headers.get('payment-signature');
      if (signature) {
        paid.push(text);
        await hold;
        const accepted = decodePaymentSignatureHeader(signature).accepted as { amount: string };
        if (accepted.amount !== priceOf(text))
          return new Response(
            JSON.stringify({ error: { message: 'payment was not accepted: Payment required.' } }),
            { status: 402 },
          );
        return new Response(paidStatus === 200 ? '{"choices":[]}' : 'down', {
          status: paidStatus,
          headers: paidStatus === 200 ? { 'x-request-cost-atomic': '7321' } : {},
        });
      }
      unpaid.push(text);
      return seller('7321', PAYEE, priceOf(text)).fetchImpl(input, init);
    };
    return { fetchImpl, unpaid, paid };
  }
  const payer = async () => {
    dir = await mkdtemp(join(tmpdir(), 'neon-seller-'));
    return privateKeyToAccount(generatePrivateKey());
  };

  // Failure caught by the live check at ef6ae364: the unpaid request carried filler of the draft's
  // size, so the seller quoted the filler's price. A payment is accepted only for the price of the
  // body that carries it, so the real draft was refused (402) and the call failed with its voucher
  // sent. The request that is quoted is the request that is paid.
  it('quotes the real request and pays for it, so the seller accepts the payment', async () => {
    const account = await payer();
    const { fetchImpl, unpaid, paid } = recording();
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      fetchImpl,
    });
    const answer = await batch.post(body, new AbortController().signal, 1_000_000n);
    expect(answer.status).toBe(200);
    expect(unpaid).toEqual([body]);
    expect(paid).toEqual([body]);
    expect(answer.ceilingAtomic).toBe(BigInt(priceOf(body)));
  });

  it('sends no payment where the limits refuse it, and releases what it held', async () => {
    const account = await payer();
    const { fetchImpl, paid } = recording();
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
    expect(batch.transmitted).toBe(false);
    expect(
      spentOf(
        (await readSpendSummary(dir)) ?? ({ committedAtomic: '0', reservations: [] } as never),
      ),
    ).toBe(0n);
  });

  // A 402 to the paid request is the seller refusing the payment: nothing is owed, so nothing
  // stays counted against the day.
  it('gives the reservation back when the seller answers 402 to the paid request', async () => {
    const account = await payer();
    const { fetchImpl } = recording();
    // A seller that quotes one price and wants another for the paid body.
    const moving: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input.clone() : new Request(input, init);
      if (request.headers.has('payment-signature'))
        return new Response('{"error":{"message":"payment was not accepted"}}', { status: 402 });
      return fetchImpl(input, init);
    };
    const authorizer = createLocalSpendAuthorizer({
      dir,
      policy: { maxAutoSpendAtomic: 1_000_000n, sessionBudgetAtomic: null, allowlistCreators: [] },
    });
    const batch = new BatchSeller({
      dataDir: dir,
      terms: TERMS,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      authorizer,
      fetchImpl: moving,
    });
    const answer = await batch.post(body, new AbortController().signal, 1_000_000n);
    expect(answer).toMatchObject({ status: 402, paymentRefused: true });
    const kept = (await readSpendSummary(dir))!;
    expect(spentOf(kept)).toBe(0n);
    expect(kept.reservations).toEqual([]);
  });

  // Failure caught by review (money): an approval made every later call of the job pay past the
  // limits. It follows the tool payer: a quote's yes pays ONE payment over the per-call limit or the
  // day's budget as an approved payment (the allowlist still applies), spent once; the next call goes
  // back to the normal checks, and concurrent calls cannot spend the same approval twice.
  describe('a payment the person approved past a limit', () => {
    const CEILING = BigInt(priceOf(body)); // what the seller stub's 402 asks for
    let account: Awaited<ReturnType<typeof payer>>;
    function setup(budget: bigint | null, approved = 1_000_000n) {
      const left = { value: approved };
      const restored: bigint[] = [];
      // A barrier on the decision itself: it opens when two payments have asked for the approval,
      // and the payment that won is held at the seller until then, so the second asked while the
      // first was still pending and not yet charged.
      let asking = 0;
      let bothAsked!: () => void;
      const bothHaveAsked = new Promise<void>((resolve) => (bothAsked = resolve));
      const approval = () => ({
        leftAtomic: left.value,
        consume: async (amount: bigint) => {
          asking += 1;
          if (asking === 2) bothAsked();
          if (amount > left.value) return false;
          left.value -= amount;
          return true;
        },
        restore: async (amount: bigint) => {
          left.value += amount;
          restored.push(amount);
        },
      });
      const call = async (key: string, withApproval = true, hold?: Promise<void>) => {
        const { fetchImpl, paid } = recording(200, hold);
        const batch = new BatchSeller({
          dataDir: dir,
          terms: TERMS,
          provider: { getSigner: async () => account } as never,
          admit: async () => undefined,
          authorizer: createLocalSpendAuthorizer({
            dir,
            policy: {
              maxAutoSpendAtomic: 1_000n,
              sessionBudgetAtomic: budget,
              allowlistCreators: [],
            },
          }),
          requestKey: key,
          ...(withApproval ? { approval: approval() } : {}),
          fetchImpl,
        });
        return batch
          .post(body, new AbortController().signal, 1_000_000n)
          .then(() => ({ outcome: 'paid', paid: paid.length }))
          .catch(() => ({ outcome: 'refused', paid: paid.length }));
      };
      return { left, restored, call, bothHaveAsked };
    }

    it('passes the per-call limit once, and the next call goes back to the limit', async () => {
      account = await payer();
      const t = setup(null);
      expect(await t.call('a', false)).toEqual({ outcome: 'refused', paid: 0 });
      expect(await t.call('b')).toEqual({ outcome: 'paid', paid: 1 });
      expect(t.left.value).toBe(1_000_000n - CEILING);
      // A later call with nothing left of the approval goes back to the normal check.
      t.left.value = 0n;
      expect(await t.call('c')).toEqual({ outcome: 'refused', paid: 0 });
    });

    it('passes a tight day budget once, as the tool payer does, and asks again for the next call', async () => {
      account = await payer();
      // Room for no call at all: the day's budget is below one call's ceiling.
      const t = setup(30_000n, CEILING);
      expect(await t.call('first')).toEqual({ outcome: 'paid', paid: 1 });
      // Approved spend is recorded in the ledger's total, beside the automatic budget (the tool
      // payer's own rule), and the approval is gone: the second call is refused.
      expect(spentOf((await readSpendSummary(dir))!)).toBe(0n);
      expect(await t.call('second')).toEqual({ outcome: 'refused', paid: 0 });
      expect(t.left.value).toBe(0n);
    });

    it('spends one approval once when two calls run together', async () => {
      account = await payer();
      const t = setup(30_000n, CEILING);
      const running = Promise.all([
        t.call('one', true, t.bothHaveAsked),
        t.call('two', true, t.bothHaveAsked),
      ]);
      const outcomes = await running;
      expect(outcomes.filter(({ outcome }) => outcome === 'paid')).toHaveLength(1);
      expect(outcomes.reduce((sum, { paid }) => sum + paid, 0)).toBe(1);
    });

    it('gives the approval back when the allowlist still refuses the payment', async () => {
      account = await payer();
      const left = { value: 1_000_000n };
      const restored: bigint[] = [];
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
            allowlistCreators: ['somebody.else'],
          },
        }),
        approval: {
          leftAtomic: left.value,
          consume: async (amount) => {
            left.value -= amount;
            return true;
          },
          restore: async (amount) => {
            left.value += amount;
            restored.push(amount);
          },
        },
        fetchImpl,
      });
      await expect(batch.post(body, new AbortController().signal, 1_000_000n)).rejects.toThrow();
      expect(paid).toHaveLength(0);
      expect(left.value).toBe(1_000_000n);
    });
  });

  // The terms are the server's row, saved with the job: changing them changes where the request
  // goes and whom the payment may name, with nothing of either written in the CLI.
  it('sends to the url the row names, and pays only the payee it names', async () => {
    const account = await payer();
    const urls: string[] = [];
    const inner = seller('7321');
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return inner.fetchImpl(input, init);
    };
    const moved = { ...TERMS, url: 'https://other-seller.example/v2/chat' };
    const batch = new BatchSeller({
      dataDir: dir,
      terms: moved,
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      fetchImpl,
    });
    // The live 402 still names the old payee and the old resource: the new row's payee does not
    // match it, so nothing is signed, and the request went to the new url.
    await expect(batch.post(body, new AbortController().signal, 1_000_000n)).resolves.toBeDefined();
    expect(urls[0]).toBe('https://other-seller.example/v2/chat');
    const other = new BatchSeller({
      dataDir: dir,
      terms: { ...TERMS, payTo: '0x00000000000000000000000000000000DeaDBeef' },
      provider: { getSigner: async () => account } as never,
      admit: async () => undefined,
      fetchImpl: seller('7321').fetchImpl,
    });
    await expect(other.post(body, new AbortController().signal, 1_000_000n)).rejects.toBeInstanceOf(
      PayeeMismatch,
    );
  });

  it('signs and pays nothing when the seller names another payee than the row', async () => {
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
    expect(batch.transmitted).toBe(false);
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
