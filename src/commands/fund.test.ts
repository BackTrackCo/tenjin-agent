import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import { SESSION_CHAIN_ID } from '../lib/session-key';
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
/** Every advisory line one run wrote to stderr, in order. */
let stderr: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-fund-'));
  dataDir = join(tmp, '.tenjin');
  stderr = [];
  mockedBalance.mockReset();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(overrides: { isTTY?: boolean; json?: boolean } = {}): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const errStream = {
    write: (chunk: string) => {
      stderr.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: overrides.json ?? true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: errStream, isTTY: overrides.isTTY ?? false },
  };
}

/**
 * A provider around a real in-memory key, so buildSiwxHeader signs for real.
 * `casing` forces the store's laxer shape (it accepts any hex casing) so the
 * checksum normalization the route requires is testable.
 */
function fakeProvider(casing: 'checksum' | 'lower' = 'checksum'): {
  provider: WalletProvider;
  address: Address;
} {
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
      address: casing === 'lower' ? (account.address.toLowerCase() as Address) : account.address,
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
    expect(calls[0]!.body).toEqual({ mode: 'onramp', address });
    expect(res.data).toMatchObject({
      address,
      checkoutUrl: CHECKOUT,
      funded: false,
      pollStatus: 'skipped',
    });
    expect(mockedBalance).not.toHaveBeenCalled();

    // What the route's withAuth actually checks, not merely that a header exists:
    // a proof bound to another domain, chain, or key would pass a defined-check.
    const proof = parseSIWxHeader(calls[0]!.headers['sign-in-with-x']!) as Record<string, unknown>;
    expect(proof.domain).toBe('tenjin.blog');
    expect(proof.chainId).toBe(SESSION_CHAIN_ID);
    expect(String(proof.address).toLowerCase()).toBe(address.toLowerCase());
  });

  it('ignores every base-url override: the mint is pinned to production', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    const ctx = makeCtx();
    // Hostile overrides on both surfaces a caller controls: the global flag and
    // the config file. Neither may steer where the wallet's SIWX proof goes.
    (ctx.flags as { baseUrl?: string }).baseUrl = 'https://evil.example';
    await mkdir(ctx.dataDir, { recursive: true });
    await writeFile(
      join(ctx.dataDir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://evil.example' }),
    );
    await runFund(ctx, { provider, fetchImpl, wait: false, open: false });

    expect(calls[0]!.url).toBe('https://tenjin.blog/api/cdp/session');
  });

  it('normalizes a lowercase stored address to EIP-55 for the route and the envelope', async () => {
    const { provider, address } = fakeProvider('lower');
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    const res = await runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false });

    // The route parses this with strict EIP-55; the local store does not, so an
    // imported wallet file would otherwise earn an unactionable 400.
    expect(calls[0]!.body).toEqual({ mode: 'onramp', address });
    expect(res.data).toMatchObject({ address });
  });

  it('prints the checkout link on stderr even when piped with --json, before any wait', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValueOnce(0n).mockResolvedValueOnce(5000n);
    // Snapshot stderr at the moment the poll first sleeps: the link must already
    // be out. Without it a piped caller learns the URL only from the envelope,
    // which is written after the poll and therefore after the ~5 min expiry.
    let printedBeforePoll = '';
    const sleep = async (): Promise<void> => {
      if (printedBeforePoll === '') printedBeforePoll = stderr.join('');
    };
    const res = await runFund(makeCtx({ isTTY: false, json: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      wait: true,
      sleep,
      pollIntervalMs: 1,
      pollTimeoutMs: 60000,
    });

    expect(res.data).toMatchObject({ pollStatus: 'arrived' });
    expect(printedBeforePoll).toContain(CHECKOUT);
    expect(printedBeforePoll).toContain(address);
    expect(printedBeforePoll).toContain('expires in ~5 minutes');
    // The close-the-tab notice rides arrival only: after the poll, not before.
    expect(printedBeforePoll).not.toContain('close the checkout tab');
    expect(stderr.join('')).toContain('USDC arrived - you can close the checkout tab.');
  });

  it('waits by default at a TTY and returns immediately when piped', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(1000n);

    // Piped: no baseline read at all, so nothing can block on a dead link.
    const piped = await runFund(makeCtx({ isTTY: false }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
    });
    expect(piped.data).toMatchObject({ funded: false, pollStatus: 'skipped' });
    expect(mockedBalance).not.toHaveBeenCalled();

    // TTY: the baseline is read and the poll runs, with no explicit `wait`.
    mockedBalance.mockResolvedValueOnce(1000n).mockResolvedValueOnce(9000n);
    const tty = await runFund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 60000,
    });
    expect(tty.data).toMatchObject({ funded: true, pollStatus: 'arrived' });
  });

  it('maps a rejected proof (401) to a local fix, not "retry"', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(401, { error: { code: 'unauthorized' } });
    const err = await catchCliError(
      runFund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('clock');
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

  it('maps 429 to RATE_LIMITED and 503 to API_UNREACHABLE', async () => {
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
    expect(unconfigured.fix).toContain('Retry');
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
    const res = await runFund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      sleep,
      pollIntervalMs: 1,
      pollTimeoutMs: 60000,
    });
    expect(res.data).toMatchObject({
      funded: true,
      pollStatus: 'arrived',
      balance: { atomic: '5250000', usd: '5.25' },
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(res.humanLines?.join(' ')).toContain('5.25');
  });

  it('times out cleanly as a non-error after polling to the deadline', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    // A real clock, advanced only by the injected sleep, so the loop runs its
    // iterations and THEN expires; `pollTimeoutMs: 0` alone would exit on entry
    // and never exercise a poll at all.
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async (ms: number) => {
        vi.advanceTimersByTime(ms);
      });
      const res = await runFund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
        open: false,
        sleep,
        pollIntervalMs: 10,
        pollTimeoutMs: 30,
      });
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(mockedBalance).toHaveBeenCalledTimes(4); // one baseline + three polls
      expect(res.data).toMatchObject({ funded: false, pollStatus: 'timed-out' });
      expect(res.humanLines?.join(' ')).toContain('tenjin wallet balance');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips polling when the baseline read fails, instead of blocking funding', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockRejectedValue(new Error('rpc down'));
    const res = await runFund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
    });
    // `unavailable`, NOT `skipped`: the run meant to wait and could not check,
    // which is a different fact from --no-wait and from a real timeout.
    expect(res.data).toMatchObject({
      funded: false,
      pollStatus: 'unavailable',
      checkoutUrl: CHECKOUT,
    });
    expect(res.humanLines?.join(' ')).toContain('Could not read the balance');
    expect(mockedBalance).toHaveBeenCalledTimes(1);
  });
});
