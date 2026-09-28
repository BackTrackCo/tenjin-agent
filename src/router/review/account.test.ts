import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../../lib/read-test-utils';
import type { CommandContext } from '../../context';
import { connectReviewAccount } from './account';
import { reviewDir } from './store';
let ctx: CommandContext;
beforeEach(async () => {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  ctx = {
    dataDir: await mkdtemp(join(tmpdir(), 'review-account-')),
    flags: { json: true, timeout: 1000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
  await writeFile(join(ctx.dataDir, 'config.json'), JSON.stringify({ sessionBudget: '20000000' }));
});
afterEach(async () => {
  await rm(ctx.dataDir, { recursive: true, force: true });
});
function deps() {
  const challenge = buildPaymentRequired({ amount: '10000000' });
  const secret = 'test-provider-secret';
  const calls: Array<{ signed: boolean }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signed = new Headers(init?.headers).has('payment-signature');
    calls.push({ signed });
    if (signed) {
      expect(
        JSON.parse(await readFile(join(reviewDir(ctx.dataDir), 'signup-signed.json'), 'utf8'))
          .headers,
      ).toBeDefined();
      return Response.json({
        success: true,
        status: 'account_created',
        apiKey: secret,
        balanceCents: 1000,
      });
    }
    return new Response('{}', { status: 402, headers: { 'payment-required': challenge.header } });
  }) as unknown as typeof fetch;
  return {
    provider: testWalletProvider(),
    readBalance: async () => 100000000n,
    destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    fetchImpl,
    calls,
    secret,
  };
}
describe('automatic provider account', () => {
  it('never signs without separate funding consent', async () => {
    const d = deps();
    expect((await connectReviewAccount(ctx, {}, d)).data).toMatchObject({
      status: 'needs_approval',
    });
    expect(d.calls).toHaveLength(0);
  });
  it('serializes first use, stores key privately, and reuses it after restart', async () => {
    const d = deps();
    const results = await Promise.all([
      connectReviewAccount(ctx, { yes: true }, d),
      connectReviewAccount(ctx, { yes: true }, d),
    ]);
    expect(d.calls.filter((c) => c.signed)).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(d.secret);
    expect((await connectReviewAccount(ctx, { yes: true }, d)).data).toMatchObject({
      status: 'connected',
    });
    expect(d.calls.filter((c) => c.signed)).toHaveLength(1);
  });
  it('does not repurchase after an ambiguous paid response', async () => {
    const d = deps();
    d.fetchImpl = async (_url, init) =>
      new Headers(init?.headers).has('payment-signature')
        ? Response.json({ status: 'settlement_pending_review' }, { status: 202 })
        : new Response('{}', {
            status: 402,
            headers: { 'payment-required': buildPaymentRequired({ amount: '10000000' }).header },
          });
    await expect(connectReviewAccount(ctx, { yes: true }, d)).rejects.toThrow('verified account');
    await expect(connectReviewAccount(ctx, { yes: true }, d)).rejects.toThrow(
      'unresolved signed payment',
    );
  });
});
