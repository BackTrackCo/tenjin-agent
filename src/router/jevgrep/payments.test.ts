import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPay } from '../../commands/pay';
import type { CommandContext } from '../../context';
import { createLocalSpendAuthorizer } from '../../lib/wallet/spend';
import { spendLedgerPath } from '../../lib/paths';
import type { WalletProvider } from '../../lib/wallet';
import { createJevgrepPayer, JEVGREP_SUPPLIER } from './payments';

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
function payer(runId = 'run-a', maxRunAtomic = 50_000n) {
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
    supplier: JEVGREP_SUPPLIER,
    authorizer: createLocalSpendAuthorizer({
      dir,
      policy: { maxAutoSpendAtomic: 50_000n, sessionBudgetAtomic: 100_000n, allowlistCreators: [] },
    }),
  });
}
function success() {
  vi.mocked(runPay).mockImplementation(async (args, _ctx, deps) => {
    const authorization = await deps!.authorizer!.authorize({
      amountAtomic: 1000n,
      creator: 'jev-x402.vercel.app',
      requestKey: args.requestKey,
    });
    if (authorization.decision !== 'allow') throw new Error('refused');
    await deps!.beforePayment!({
      headers: { 'payment-signature': 'must-not-persist' },
      amountAtomic: '1000',
      url: JEVGREP_SUPPLIER.url,
    });
    await deps!.authorizer!.commit(authorization.reservationId, 1000n);
    return { data: { bodyText: JSON.stringify(response) } };
  });
}
describe('durable Jevgrep payments', () => {
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
      unknownAtomic: '1000',
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
    expect(await instance.summary()).toMatchObject({ unknownAtomic: '1000' });
  });
});
