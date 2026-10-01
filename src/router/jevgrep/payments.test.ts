import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPay } from '../../commands/pay';
import { CliError } from '../../lib/errors';
import type { CommandContext } from '../../context';
import { createLocalSpendAuthorizer } from '../../lib/wallet/spend';
import { spendLedgerPath } from '../../lib/paths';
import { canonicalHash } from '../../lib/request-schema';
import type { JevgrepProfileId } from './profile';
import type { WalletProvider } from '../../lib/wallet';
import { createJevgrepPayer, JEVGREP_SUPPLIER, sharedBalanceReader } from './payments';
import { MAPLE_JEVGREP_SUPPLIER, type JevgrepSupplier } from './supplier';

vi.mock('../../commands/pay', () => ({ runPay: vi.fn() }));
const request = {
  model: 'jev-1.13.0',
  state: { source: 'private-source-body' },
  questions: { relevant: { type: 'noul', instructions: 'Does it match?' } },
};
const response = { model: 'jev-1.13.0', answers: { relevant: { type: 'noul', noul: 0.8 } } };
let dir: string;
const wallet = {
  address: '0x0000000000000000000000000000000000000001',
  provider: 'test',
  credentialSource: 'file',
  policyEnforcement: 'client-only',
} as const;
const provider = {
  id: 'test',
  describe: async () => wallet,
  getSigner: async () => {
    throw new Error('No real signing in payer unit tests');
  },
  diagnostics: async () => ({ warnings: [] }),
} satisfies WalletProvider;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-jev-pay-'));
  vi.mocked(runPay).mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
function payer(
  runId = 'run-a',
  maxRunAtomic = 50_000n,
  profile?: JevgrepProfileId,
  sessionBudgetAtomic = 100_000n,
  supplier: JevgrepSupplier = JEVGREP_SUPPLIER,
) {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const ctx: CommandContext = {
    flags: { json: true, timeout: 1000 },
    dataDir: dir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
  return createJevgrepPayer({
    ctx,
    provider,
    runId,
    maxRunAtomic,
    profile,
    supplier,
    authorizer: createLocalSpendAuthorizer({
      dir,
      policy: { maxAutoSpendAtomic: 50_000n, sessionBudgetAtomic, allowlistCreators: [] },
    }),
  });
}
function success(supplier: JevgrepSupplier = JEVGREP_SUPPLIER, amountAtomic = 1000n) {
  vi.mocked(runPay).mockImplementation(async (args, _ctx, deps) => {
    const authorization = await deps!.authorizer!.authorize({
      amountAtomic,
      creator: new URL(supplier.url).host,
      requestKey: args.requestKey,
    });
    if (authorization.decision !== 'allow') throw new Error('refused');
    await deps!.beforePayment!({
      headers: { 'payment-signature': 'must-not-persist' },
      amountAtomic: amountAtomic.toString(),
      url: supplier.url,
    });
    await deps!.authorizer!.commit(authorization.reservationId, amountAtomic);
    return { data: { bodyText: JSON.stringify(response) } };
  });
}
describe('durable Jevgrep payments', () => {
  it.each([
    {
      error: new CliError('API_UNREACHABLE', 'private-message', {
        details: { status: 429, body: 'private-body', headers: 'private-signature' },
      }),
      diagnostic: { code: 'API_UNREACHABLE', phase: 'payment', status: 429 },
    },
    {
      error: new CliError('REFUSED', 'private-message', {
        details: { reason: 'balance_unavailable', address: 'private-wallet', status: '429' },
      }),
      diagnostic: { code: 'REFUSED', phase: 'payment', reason: 'balance_unavailable' },
    },
    {
      error: new CliError('REFUSED', 'private-message', {
        details: { reason: 'private-source', status: 600, cause: 'private-signature' },
      }),
      diagnostic: { code: 'REFUSED', phase: 'payment' },
    },
    {
      error: new CliError('PAYMENT_FAILED', 'private-message', {
        details: {
          status: 402,
          paymentFailure: { stage: 'settlement', reason: 'private-source' },
        },
      }),
      diagnostic: { code: 'PAYMENT_FAILED', phase: 'payment', status: 402 },
    },
    {
      error: Object.assign(new Error('private-message'), {
        code: 'API_UNREACHABLE',
        details: { status: 429 },
      }),
      diagnostic: { code: 'UNKNOWN', phase: 'payment' },
    },
  ])(
    'retains only allowlisted pre-payment diagnostics: $diagnostic',
    async ({ error, diagnostic }) => {
      vi.mocked(runPay).mockRejectedValue(error);
      await expect(payer().evaluate(request)).rejects.toMatchObject({
        details: { reason: 'provider', diagnostic },
      });
      const root = join(dir, 'jevgrep', 'payments');
      const runDir = join(
        root,
        (await readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name))!,
      );
      const failed = (await readdir(runDir)).find((name) => name.endsWith('.failed.json'))!;
      const raw = await readFile(join(runDir, failed), 'utf8');
      expect(JSON.parse(raw)).toEqual({ version: 1, state: 'untransmitted', diagnostic });
      expect(raw).not.toContain('private-');
      // Nothing was signed, so the same evaluation is admitted again and fails the same way.
      await expect(payer().evaluate(request)).rejects.toMatchObject({
        details: { reason: 'provider', diagnostic },
      });
      expect(runPay).toHaveBeenCalledTimes(2);
    },
  );

  it('re-admits an evaluation after an untransmitted failure and drops its failure record', async () => {
    vi.mocked(runPay).mockRejectedValueOnce(
      new CliError('NETWORK_ERROR', 'private-socket-reset', { details: {} }),
    );
    await expect(payer().evaluate(request)).rejects.toMatchObject({
      details: { reason: 'provider', diagnostic: { code: 'NETWORK_ERROR', phase: 'payment' } },
    });
    success();
    await expect(payer().evaluate(request)).resolves.toEqual(response);
    expect(runPay).toHaveBeenCalledTimes(2);
    const root = join(dir, 'jevgrep', 'payments');
    const runDir = join(
      root,
      (await readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name))!,
    );
    const names = await readdir(runDir);
    expect(names.some((name) => name.endsWith('.failed.json'))).toBe(false);
    expect(names.filter((name) => name.endsWith('.attempt.json'))).toHaveLength(1);
    expect(names.some((name) => name.endsWith('.response.json'))).toBe(true);
    // The saved response now replays without a third transmission.
    await expect(payer().evaluate(request)).resolves.toEqual(response);
    expect(runPay).toHaveBeenCalledTimes(2);
  });

  it('distinguishes response validation from payment transport failures', async () => {
    vi.mocked(runPay).mockResolvedValue({ data: { bodyText: 'private-invalid-response' } });
    await expect(payer().evaluate(request)).rejects.toMatchObject({
      details: {
        reason: 'provider',
        diagnostic: { code: 'REFUSED', phase: 'response_validation' },
      },
    });
  });

  it('journals a closed settlement diagnostic while preserving uncertain exposure and retry guards', async () => {
    vi.mocked(runPay).mockImplementation(async (_args, _ctx, deps) => {
      await deps!.authorizer!.authorize({ amountAtomic: 1000n, creator: 'jev-x402.vercel.app' });
      await deps!.beforePayment!({ headers: {}, amountAtomic: '1000', url: JEVGREP_SUPPLIER.url });
      throw new CliError('PAYMENT_FAILED', 'private-message', {
        details: {
          status: 402,
          body: 'private-source',
          paymentFailure: {
            stage: 'settlement',
            reason: 'provider_payment_method_required',
            header: 'private-signature',
          },
        },
      });
    });
    const diagnostic = {
      code: 'PAYMENT_FAILED',
      phase: 'payment',
      status: 402,
      paymentFailure: { stage: 'settlement', reason: 'provider_payment_method_required' },
    };
    const instance = payer();
    await expect(instance.evaluate(request)).rejects.toMatchObject({
      details: { reason: 'payment_uncertain', diagnostic },
    });
    const root = join(dir, 'jevgrep', 'payments');
    const runDir = join(
      root,
      (await readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name))!,
    );
    const failed = (await readdir(runDir)).find((name) => name.endsWith('.failed.json'))!;
    const raw = await readFile(join(runDir, failed), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, state: 'uncertain', diagnostic });
    expect(raw).not.toContain('private-');
    expect(await instance.summary()).toMatchObject({ unknownAtomic: '1000' });
    await expect(payer().evaluate(request)).rejects.toThrow('no duplicate');
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent identical requests and replays a completed response after restart', async () => {
    success();
    const first = payer();
    const both = await Promise.all([first.evaluate(request), first.evaluate(request)]);
    expect(both).toEqual([response, response]);
    expect(await payer().evaluate(request)).toEqual(response);
    expect(runPay).toHaveBeenCalledTimes(1);
    expect(await first.summary()).toMatchObject({
      exposureAtomic: '1000',
      confirmedAtomic: '0',
      unknownAtomic: '0',
      settledAtomic: '1000',
    });
    const runDir = join(
      dir,
      'jevgrep',
      'payments',
      (await readdir(join(dir, 'jevgrep', 'payments')))[0]!,
    );
    for (const name of await readdir(runDir)) {
      const raw = await readFile(join(runDir, name), 'utf8');
      expect(raw).not.toContain('private-source-body');
      expect(raw).not.toContain('must-not-persist');
    }
  });

  it('joins separate payer instances without issuing another payment', async () => {
    success();
    expect(await Promise.all([payer().evaluate(request), payer().evaluate(request)])).toEqual([
      response,
      response,
    ]);
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('keeps signed exposure after a lost response and refuses a retry after restart', async () => {
    vi.mocked(runPay).mockImplementation(async (_args, _ctx, deps) => {
      await deps!.authorizer!.authorize({ amountAtomic: 1000n, creator: 'jev-x402.vercel.app' });
      await deps!.beforePayment!({ headers: {}, amountAtomic: '1000', url: JEVGREP_SUPPLIER.url });
      throw new Error('lost paid response containing secret');
    });
    await expect(payer().evaluate(request)).rejects.toThrow('uncertain');
    const restarted = payer();
    await expect(restarted.evaluate(request)).rejects.toThrow('no duplicate');
    expect(runPay).toHaveBeenCalledTimes(1);
    expect(await restarted.summary()).toMatchObject({ unknownAtomic: '1000' });
  });

  it('rejects changed run terms and invalid native responses without replacing payment', async () => {
    success();
    await payer().evaluate(request);
    await expect(payer('run-a', 10_000n).evaluate(request)).rejects.toThrow(
      'different payment terms',
    );
    vi.mocked(runPay).mockResolvedValue({ data: { bodyText: '{"answers":{}}' } });
    await expect(payer('run-b').evaluate(request)).rejects.toThrow('before payment transmission');
    await expect(payer('run-b').evaluate(request)).rejects.toThrow('no duplicate');
    expect(runPay).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before dispatch and validates request bodies before pay', async () => {
    success();
    await expect(payer().evaluate(request, AbortSignal.abort())).rejects.toThrow();
    await expect(payer().evaluate({ ...request, model: 'attacker-model' })).rejects.toThrow();
    expect(runPay).not.toHaveBeenCalled();
  });

  it('retains exposure when cancelled after signing, without sending a replacement', async () => {
    const controller = new AbortController();
    vi.mocked(runPay).mockImplementation(async (_args, _ctx, deps) => {
      await deps!.authorizer!.authorize({ amountAtomic: 1000n, creator: 'jev-x402.vercel.app' });
      await deps!.beforePayment!({ headers: {}, amountAtomic: '1000', url: JEVGREP_SUPPLIER.url });
      controller.abort();
      deps!.signal!.throwIfAborted();
      throw new Error('unreachable');
    });
    const instance = payer();
    await expect(instance.evaluate(request, controller.signal)).rejects.toThrow();
    expect(await instance.summary()).toMatchObject({ unknownAtomic: '1000' });
    await expect(payer().evaluate(request)).rejects.toThrow('no duplicate');
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('refuses corrupted replay evidence instead of buying a replacement', async () => {
    success();
    await payer().evaluate(request);
    const root = join(dir, 'jevgrep', 'payments');
    const runDir = join(
      root,
      (await readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name))!,
    );
    const receipt = (await readdir(runDir)).find((name) => name.endsWith('.response.json'))!;
    await writeFile(join(runDir, receipt), 'corrupted receipt');
    await expect(payer().evaluate(request)).rejects.toThrow('recovery');
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('checks durable accounting before even an unpaid provider probe', async () => {
    success();
    await payer().evaluate(request);
    await rm(spendLedgerPath(dir));
    await expect(payer('new-run').evaluate(request)).rejects.toThrow('recovery');
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('refuses a second distinct evaluation once the aggregate run ceiling is full', async () => {
    success();
    const instance = payer('small-run', 1000n);
    await instance.evaluate(request);
    await expect(
      instance.evaluate({ ...request, state: { source: 'another question' } }),
    ).rejects.toThrow('budget');
    expect(await instance.summary()).toMatchObject({
      exposureAtomic: '1000',
      settledAtomic: '1000',
    });
  });
});

describe('Maple per-request Jevgrep payments', () => {
  const maplePayer = (runId = 'maple-run', supplier: JevgrepSupplier = MAPLE_JEVGREP_SUPPLIER) =>
    payer(runId, 50_000n, undefined, 100_000n, supplier);

  it('pays the live quote with pinned terms, adapts state, and replays without another payment', async () => {
    success(MAPLE_JEVGREP_SUPPLIER, 1008n);
    const original = structuredClone(request);
    const instance = maplePayer();
    expect(await Promise.all([instance.evaluate(request), instance.evaluate(request)])).toEqual([
      response,
      response,
    ]);
    expect(await maplePayer().evaluate(request)).toEqual(response);
    expect(request).toEqual(original);
    expect(runPay).toHaveBeenCalledTimes(1);
    const args = vi.mocked(runPay).mock.calls[0]![0];
    expect(args).toMatchObject({
      url: MAPLE_JEVGREP_SUPPLIER.url,
      method: 'POST',
      execution: 'router',
      terms: {
        source: 'maple-jev',
        network: MAPLE_JEVGREP_SUPPLIER.network,
        asset: MAPLE_JEVGREP_SUPPLIER.asset,
        payTo: MAPLE_JEVGREP_SUPPLIER.payTo,
        maxAmountAtomic: '10000',
      },
    });
    expect(JSON.parse(args.rawBody!)).toEqual({
      ...request,
      model: 'jev-latest',
      state: JSON.stringify(request.state),
    });
    expect(await instance.summary()).toMatchObject({
      requests: 1,
      exposureAtomic: '1008',
      unknownAtomic: '0',
      settledAtomic: '1008',
    });
    const journal = join(dir, 'jevgrep', 'payments', canonicalHash('maple-run'));
    for (const name of await readdir(journal)) {
      const raw = await readFile(join(journal, name), 'utf8');
      expect(raw).not.toContain('private-source-body');
      expect(raw).not.toContain('must-not-persist');
    }
  });

  it('preserves string state without double encoding and retains verified usage', async () => {
    vi.mocked(runPay).mockResolvedValue({
      data: {
        bodyText: JSON.stringify({
          ...response,
          usage: { input_tokens: 48, output_tokens: 2 },
        }),
      },
    });
    const input = { ...request, state: 'function retry() {\n return "cached 🍁";\n}' };
    await expect(maplePayer().evaluate(input)).resolves.toMatchObject({
      model: 'jev-1.13.0',
      usage: { input_tokens: 48, output_tokens: 2 },
    });
    expect(JSON.parse(vi.mocked(runPay).mock.calls[0]![0].rawBody!).state).toBe(input.state);
  });

  it('refuses post-adaptation byte overflow before network or durable admission', async () => {
    await expect(
      maplePayer().evaluate({ ...request, state: { source: '"'.repeat(40_000) } }),
    ).rejects.toThrow('adapted evaluation request exceeds');
    expect(runPay).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(['jev-latest', undefined])(
    'keeps paid exposure and refuses unpinned response model %s',
    async (model) => {
      vi.mocked(runPay).mockImplementation(async (_args, _ctx, deps) => {
        await deps!.authorizer!.authorize({ amountAtomic: 1008n, creator: 'base.mapleai.shop' });
        await deps!.beforePayment!({
          headers: {},
          amountAtomic: '1008',
          url: MAPLE_JEVGREP_SUPPLIER.url,
        });
        return { data: { bodyText: JSON.stringify({ ...response, model }) } };
      });
      const instance = maplePayer();
      await expect(instance.evaluate(request)).rejects.toMatchObject({
        details: {
          reason: 'payment_uncertain',
          diagnostic: { code: 'REFUSED', phase: 'response_validation' },
        },
      });
      expect(await instance.summary()).toMatchObject({ unknownAtomic: '1008' });
      await expect(maplePayer().evaluate(request)).rejects.toThrow('no duplicate');
      expect(runPay).toHaveBeenCalledTimes(1);
      const journal = join(dir, 'jevgrep', 'payments', canonicalHash('maple-run'));
      expect((await readdir(journal)).some((name) => name.endsWith('.response.json'))).toBe(false);
    },
  );

  it('validates pinned provenance again on disk replay without issuing another payment', async () => {
    success(MAPLE_JEVGREP_SUPPLIER, 1008n);
    await maplePayer().evaluate(request);
    const journal = join(dir, 'jevgrep', 'payments', canonicalHash('maple-run'));
    const receipt = (await readdir(journal)).find((name) => name.endsWith('.response.json'))!;
    await writeFile(join(journal, receipt), JSON.stringify({ answers: response.answers }));
    await expect(maplePayer().evaluate(request)).rejects.toThrow('approved evaluation model');
    expect(runPay).toHaveBeenCalledTimes(1);
  });

  it('rejects altered supplier terms and reuse of a legacy supplier journal', async () => {
    expect(() =>
      maplePayer('changed', {
        ...MAPLE_JEVGREP_SUPPLIER,
        maxAmountAtomic: '20000',
      } as unknown as JevgrepSupplier),
    ).toThrow('approved payment terms');
    success();
    await payer('shared').evaluate(request);
    await expect(maplePayer('shared').evaluate(request)).rejects.toThrow('different payment terms');
    expect(runPay).toHaveBeenCalledTimes(1);
  });
});

it('requires explicit extended profile for a larger cap and binds profile into replay scope', async () => {
  expect(() => payer('standard', 50_001n)).toThrow('budget');
  expect(() => payer('extended', 1_000_001n, 'extended-v1')).toThrow('budget');
  success();
  await payer('same', 1000n).evaluate(request);
  await expect(payer('same', 1000n, 'extended-v1').evaluate(request)).rejects.toThrow(
    'different payment terms',
  );
  expect(runPay).toHaveBeenCalledTimes(1);
});
it('enforces the one-dollar durable cap atomically at the final two concurrent requests', async () => {
  const authorizer = createLocalSpendAuthorizer({
    dir,
    policy: {
      maxAutoSpendAtomic: 1_000_000n,
      sessionBudgetAtomic: 2_000_000n,
      allowlistCreators: [],
    },
  });
  const seeded = await authorizer.authorize({
    amountAtomic: 999_000n,
    creator: 'jev-x402.vercel.app',
    requestKey: 'seed',
    durableRun: { id: 'extended-race', maxAtomic: 1_000_000n },
  });
  expect(seeded.decision).toBe('allow');
  if (seeded.decision !== 'allow') throw Error('seed refused');
  await authorizer.markSigned!(seeded.reservationId!);
  await authorizer.commit(seeded.reservationId!, 999_000n);
  success();
  const instance = payer('extended-race', 1_000_000n, 'extended-v1', 2_000_000n);
  const result = await Promise.allSettled([
    instance.evaluate(request),
    instance.evaluate({ ...request, state: 'different' }),
  ]);
  expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(await instance.summary()).toMatchObject({
    exposureAtomic: '1000000',
    unknownAtomic: '999000',
    settledAtomic: '1000',
    reservedAtomic: '0',
  });
});
it('shares normal wallet limits across separate extended scopes', async () => {
  success();
  const a = payer('extended-a', 1_000_000n, 'extended-v1', 1000n);
  const b = payer('extended-b', 1_000_000n, 'extended-v1', 1000n);
  const results = await Promise.allSettled([a.evaluate(request), b.evaluate(request)]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(
    BigInt((await a.summary()).exposureAtomic) + BigInt((await b.summary()).exposureAtomic),
  ).toBe(1000n);
});
it('durably admits at most 1000 extended attempts across concurrent instances', async () => {
  success();
  await payer('attempts', 1_000_000n, 'extended-v1').evaluate(request);
  const journal = join(dir, 'jevgrep', 'payments', canonicalHash('attempts'));
  await Promise.all(
    Array.from({ length: 998 }, (_, i) => writeFile(join(journal, `seed-${i}.attempt.json`), '{}')),
  );
  const results = await Promise.allSettled([
    payer('attempts', 1_000_000n, 'extended-v1').evaluate({ ...request, state: 'next-a' }),
    payer('attempts', 1_000_000n, 'extended-v1').evaluate({ ...request, state: 'next-b' }),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect((await readdir(journal)).filter((name) => name.endsWith('.attempt.json'))).toHaveLength(
    1000,
  );
  expect(runPay).toHaveBeenCalledTimes(2);
});
it('closes admission, aborts active payment work, and drains it before returning', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(runPay).mockImplementation(async (_args, _ctx, deps) => {
    await deps!.authorizer!.authorize({ amountAtomic: 1000n, creator: 'jev-x402.vercel.app' });
    await deps!.beforePayment!({ headers: {}, amountAtomic: '1000', url: JEVGREP_SUPPLIER.url });
    started();
    await new Promise<void>((resolve) =>
      deps!.signal!.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }),
    );
    throw Error('cancelled after signing');
  });
  const instance = payer();
  const result = instance.evaluate(request).catch(() => undefined);
  await ready;
  expect(await instance.close()).toEqual({ drainCompleted: true, pendingEvaluations: 0 });
  await result;
  expect(await instance.summary()).toMatchObject({ unknownAtomic: '1000' });
  await expect(instance.evaluate(request)).rejects.toThrow('closed');
  expect(runPay).toHaveBeenCalledTimes(1);
});
it('bounds the drain when a payment callback ignores cancellation', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (value: { data: { bodyText: string } }) => void;
  vi.mocked(runPay).mockImplementation(async () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const instance = payer();
  const operation = instance.evaluate(request);
  await ready;
  vi.useFakeTimers();
  try {
    const closed = instance.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await closed).toEqual({ drainCompleted: false, pendingEvaluations: 1 });
  } finally {
    vi.useRealTimers();
    finish({ data: { bodyText: JSON.stringify(response) } });
    await operation;
  }
});

describe('shared balance reader', () => {
  it('serves concurrent evaluations from one read and refreshes after the TTL or a failure', async () => {
    let now = 0;
    const read = vi.fn(async (): Promise<bigint | null> => 5000n);
    const reader = sharedBalanceReader(read, 1000, () => now);
    const opts = { timeoutMs: 100 };
    expect(await Promise.all([reader('0xa', 'rpc', opts), reader('0xa', 'rpc', opts)])).toEqual([
      5000n,
      5000n,
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    now = 999;
    expect(await reader('0xa', 'rpc', opts)).toBe(5000n);
    expect(read).toHaveBeenCalledTimes(1);
    now = 1000;
    read.mockResolvedValueOnce(null);
    expect(await reader('0xa', 'rpc', opts)).toBeNull();
    expect(await reader('0xa', 'rpc', opts)).toBe(5000n);
    expect(read).toHaveBeenCalledTimes(3);
    // A different wallet or RPC never reuses another's value.
    expect(await reader('0xb', 'rpc', opts)).toBe(5000n);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
