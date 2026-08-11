import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';

// The only chain touch is the balance read; mock it so the suite is offline.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import { runFund } from './fund';

const mockedBalance = vi.mocked(getUsdcBalance);
const CHECKOUT = 'https://pay.coinbase.com/buy?sessionToken=tok123';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-fund-'));
  dataDir = join(tmp, '.tenjin');
  mockedBalance.mockReset();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(overrides: { isTTY?: boolean } = {}): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: sink, isTTY: overrides.isTTY ?? false },
  };
}

/** A provider around a real in-memory key, so buildSiwxHeader signs for real. */
function fakeProvider(): { provider: WalletProvider; address: Address } {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer: TenjinSigner = {
    address: account.address,
    signMessage: (a) => account.signMessage(a),
    signTypedData: (a) => account.signTypedData(a as never),
    signTransaction: (tx) => account.signTransaction(tx),
  };
  const provider: WalletProvider = {
    id: 'fake',
    describe: async () => ({
      address: account.address,
      provider: 'fake',
      credentialSource: 'remote',
      policyEnforcement: 'provider',
    }),
    getSigner: async () => signer,
    diagnostics: async () => ({ warnings: [] }),
  };
  return { provider, address: account.address };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(status: number, json: unknown): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    return err as CliError;
  }
  throw new Error('expected a CliError');
}

describe('runFund', () => {
  it('mints a session for the signing wallet and returns the checkout URL', async () => {
    const { provider, address } = fakeProvider();
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    const res = await runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://tenjin.blog/api/cdp/session');
    expect(calls[0]!.headers['sign-in-with-x']).toBeDefined();
    expect(calls[0]!.body).toEqual({ mode: 'onramp', address });
    expect(res.data).toMatchObject({ address, checkoutUrl: CHECKOUT, funded: false });
    expect(mockedBalance).not.toHaveBeenCalled();
  });

  it('forwards a positive amount as presetAmount', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    await runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false, amountUsd: '5' });
    expect(calls[0]!.body).toMatchObject({ presetAmount: 5 });
  });

  it.each(['abc', '0', '-3', '100001'])('refuses amount %s as USAGE', async (amountUsd) => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(200, { url: CHECKOUT });
    const err = await catchCliError(
      runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false, amountUsd }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  it.each([
    ['http://pay.coinbase.com/buy?sessionToken=x'],
    ['https://evil.example/buy'],
    ['https://pay.coinbase.com.evil.example/buy'],
  ])('refuses to open a non-Coinbase checkout URL (%s)', async (url) => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(200, { url });
    const openUrl = vi.fn(async () => true);
    const err = await catchCliError(
      runFund(makeCtx({ isTTY: true }), { provider, fetchImpl, wait: false, openUrl }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps region_not_supported to REFUSED (exit 3)', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(403, {
      error: { code: 'region_not_supported', message: 'no' },
    });
    const err = await catchCliError(
      runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
  });

  it('maps 429 to RATE_LIMITED and 503 to API_UNREACHABLE with the canonical-baseUrl fix', async () => {
    const { provider } = fakeProvider();
    const limited = await catchCliError(
      runFund(makeCtx(), {
        provider,
        fetchImpl: stubFetch(429, { error: { code: 'rate_limited' } }).fetchImpl,
        wait: false,
        open: false,
      }),
    );
    expect(limited.code).toBe('RATE_LIMITED');

    const unconfigured = await catchCliError(
      runFund(makeCtx(), {
        provider,
        fetchImpl: stubFetch(503, { error: { code: 'cdp_not_configured' } }).fetchImpl,
        wait: false,
        open: false,
      }),
    );
    expect(unconfigured.code).toBe('API_UNREACHABLE');
    expect(unconfigured.fix).toContain('tenjin.blog');
  });

  it('maps a transport failure to NETWORK_ERROR', async () => {
    const { provider } = fakeProvider();
    const fetchImpl = (async () => {
      throw new Error('socket down');
    }) as typeof fetch;
    const err = await catchCliError(
      runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('opens the browser at a TTY and skips it when piped or --no-open', async () => {
    const { provider } = fakeProvider();
    const openUrl = vi.fn(async () => true);
    await runFund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      openUrl,
    });
    expect(openUrl).toHaveBeenCalledWith(CHECKOUT);

    openUrl.mockClear();
    await runFund(makeCtx({ isTTY: false }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      openUrl,
    });
    await runFund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      open: false,
      openUrl,
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('polls until the balance rises above the pre-mint baseline', async () => {
    const { provider } = fakeProvider();
    mockedBalance
      .mockResolvedValueOnce(250000n) // baseline before mint
      .mockResolvedValueOnce(250000n) // first poll: nothing yet
      .mockResolvedValueOnce(5250000n); // second poll: landed
    const sleep = vi.fn(async () => {});
    const res = await runFund(makeCtx(), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      sleep,
      pollIntervalMs: 1,
      pollTimeoutMs: 60000,
    });
    expect(res.data).toMatchObject({
      funded: true,
      balance: { atomic: '5250000', usd: '5.25' },
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(res.humanLines?.join(' ')).toContain('5.25');
  });

  it('times out cleanly as a non-error when nothing arrives', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const res = await runFund(makeCtx(), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 0,
    });
    expect(res.data).toMatchObject({ funded: false });
    expect(res.humanLines?.join(' ')).toContain('tenjin wallet balance');
  });

  it('skips polling when the baseline read fails, instead of blocking funding', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockRejectedValue(new Error('rpc down'));
    const res = await runFund(makeCtx(), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
    });
    expect(res.data).toMatchObject({ funded: false, checkoutUrl: CHECKOUT });
    expect(mockedBalance).toHaveBeenCalledTimes(1);
  });
});
