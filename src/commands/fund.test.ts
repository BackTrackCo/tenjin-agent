import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import { SIWX_CHAIN_ID } from '../lib/siwx';
import type { CommandContext } from '../context';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';

// The only chain touch is the balance read; mock it so the suite is offline.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import { runFund, type FundOptions } from './fund';
import { runBalance } from './balance';

const mockedBalance = vi.mocked(getUsdcBalance);
const CHECKOUT = 'https://pay.coinbase.com/buy?sessionToken=tok123';
/**
 * Written out here rather than read from PRODUCTION_ORIGIN, on purpose. `fund`
 * mints wallet-signed CDP session credentials at whatever origin it pins, so
 * re-pointing that has to cost two files in one PR instead of one line in
 * `production-origin.ts`: the source derives, the anchor does not. (Distinct
 * from #146: that was about user-facing overrides, this is defence in depth.)
 * At the cutover, edit both, deliberately.
 */
const EXPECTED_FUND_ORIGIN = 'https://tenjin.sh';
const EXPECTED_FUND_HOST = 'tenjin.sh';

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

function makeCtx(
  overrides: { isTTY?: boolean; json?: boolean; columns?: number } = {},
): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const errStream = {
    write: (chunk: string) => {
      stderr.push(chunk);
      return true;
    },
    // `columns` makes stderr a color terminal that wide, which is what the QR needs.
    ...(overrides.columns !== undefined
      ? { columns: overrides.columns, hasColors: () => true }
      : {}),
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

/**
 * runFund with this machine kept out of it: no harness variables from the
 * shell running the suite, no `scutil` for the device name, and a desktop
 * with a browser (a Linux CI runner has no display).
 */
function fund(ctx: CommandContext, opts: FundOptions = {}) {
  return runFund(ctx, { env: {}, platform: 'darwin', deviceName: async () => 'Test Mac', ...opts });
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
    const res = await fund(makeCtx(), { provider, fetchImpl, wait: false, open: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${EXPECTED_FUND_ORIGIN}/api/fund/link`);
    expect(calls[0]!.body).toEqual({ address, source: 'terminal', deviceName: 'Test Mac' });
    expect(res.data).toMatchObject({
      address,
      checkoutUrl: CHECKOUT,
      funded: false,
      pollStatus: 'skipped',
      nextStep: expect.stringContaining('same Tenjin executable and shell'),
    });
    // The agent waits in the background and carries on; it never asks for "done".
    const nextStep = (res.data as { nextStep: string }).nextStep;
    expect(nextStep).toContain('`tenjin balance --wait` in the background');
    expect(nextStep).toContain('Never ask the person to type "done"');
    expect(nextStep).toContain('at most once per session');
    expect(nextStep).toContain('Do not open another checkout');

    // What the route's withAuth actually checks, not merely that a header exists:
    // a proof bound to another domain, chain, or key would pass a defined-check.
    const proof = parseSIWxHeader(calls[0]!.headers['sign-in-with-x']!) as Record<string, unknown>;
    expect(proof.domain).toBe(EXPECTED_FUND_HOST);
    expect(proof.chainId).toBe(SIWX_CHAIN_ID);
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
    await fund(ctx, { provider, fetchImpl, wait: false, open: false });

    expect(calls[0]!.url).toBe(`${EXPECTED_FUND_ORIGIN}/api/fund/link`);
  });

  it('normalizes a lowercase stored address to EIP-55 for the route and the envelope', async () => {
    const { provider, address } = fakeProvider('lower');
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    const res = await fund(makeCtx(), { provider, fetchImpl, wait: false, open: false });

    // The route parses this with strict EIP-55; the local store does not, so an
    // imported wallet file would otherwise earn an unactionable 400.
    expect(calls[0]!.body).toMatchObject({ address });
    expect(res.data).toMatchObject({ address });
  });

  it('prints the checkout link on stderr even when piped with --json, before any wait', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValueOnce(0n).mockResolvedValueOnce(0n).mockResolvedValueOnce(5000n);
    // Snapshot stderr at the moment the poll first sleeps: the link must already
    // be out. Without it a piped caller learns the URL only from the envelope,
    // which is written after the poll and therefore after the ~5 min expiry.
    let printedBeforePoll = '';
    const sleep = async (): Promise<void> => {
      if (printedBeforePoll === '') printedBeforePoll = stderr.join('');
    };
    const res = await fund(makeCtx({ isTTY: false, json: true }), {
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
    expect(printedBeforePoll).toContain('expires in ~5 minutes');
    // Dollars and a link: the wallet address is not part of adding funds.
    expect(stderr.join('')).not.toContain(address);
  });

  it('waits by default at a TTY and returns immediately when piped', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(1000n);

    // Piped: one baseline read, the one `balance --wait` measures from, and no wait.
    const piped = await fund(makeCtx({ isTTY: false }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
    });
    expect(piped.data).toMatchObject({ funded: false, pollStatus: 'skipped' });
    expect(mockedBalance).toHaveBeenCalledTimes(1);
    mockedBalance.mockReset();

    // TTY: the baseline is read and the poll runs, with no explicit `wait`.
    mockedBalance.mockResolvedValueOnce(1000n).mockResolvedValueOnce(9000n);
    const tty = await fund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      open: false,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 60000,
    });
    expect(tty.data).toMatchObject({ funded: true, pollStatus: 'arrived' });
  });

  it('shows no wallet address or QR when a browser opens', async () => {
    const { provider, address } = fakeProvider();
    await fund(makeCtx({ isTTY: true, json: false, columns: 80 }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      openUrl: async () => true,
      wait: false,
    });
    const out = stderr.join('');
    expect(out).toContain(CHECKOUT);
    expect(out).not.toContain(address);
    expect(out).not.toContain('█');
  });

  it('draws a QR of the checkout link, not the address, when no browser can open (SSH)', async () => {
    const { provider, address } = fakeProvider();
    const openUrl = vi.fn(async () => true);
    await fund(makeCtx({ isTTY: true, json: false, columns: 80 }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      openUrl,
      wait: false,
      env: { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' },
    });
    expect(openUrl).not.toHaveBeenCalled();
    const lines = stderr.join('').split('\n');
    const head = lines.findIndex((l) => l.includes('No browser on this machine'));
    expect(head).toBeGreaterThan(-1);
    // The code is the link: lean-qr decodes nothing here, so check its size
    // matches the URL's QR and that the full link follows it.
    const after = lines.slice(head + 1);
    const codeRows = after.filter((l) => l.includes('█') || l.includes('▀'));
    expect(codeRows.length).toBeGreaterThan(10);
    expect(after.some((l) => l.includes(`or open  ${CHECKOUT}`))).toBe(true);
    expect(lines.join('\n')).not.toContain(address);
  });

  it.each([
    ['--json', { isTTY: true, json: true, columns: 80 }, {}],
    ['a pipe', { isTTY: false, json: false, columns: 80 }, {}],
    ['--no-qr', { isTTY: true, json: false, columns: 80 }, { qr: false }],
    ['a 36-column terminal', { isTTY: true, json: false, columns: 36 }, {}],
  ])('draws no QR for %s', async (_label, ctxOpts, fundOpts) => {
    const { provider } = fakeProvider();
    await fund(makeCtx(ctxOpts), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      openUrl: async () => true,
      wait: false,
      env: { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' },
      ...fundOpts,
    });
    expect(stderr.join('')).not.toContain('Scan to pay');
    expect(stderr.join('')).not.toContain('█');
  });

  it('maps a rejected proof (401) to a local fix, not "retry"', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(401, { error: { code: 'unauthorized' } });
    const err = await catchCliError(
      fund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('clock');
  });

  it('forwards a positive amount as presetAmount', async () => {
    const { provider, address } = fakeProvider();
    const { fetchImpl, calls } = stubFetch(200, { url: CHECKOUT });
    await fund(makeCtx(), { provider, fetchImpl, wait: false, open: false, amountUsd: '5' });
    expect(calls[0]!.body).toMatchObject({ address, presetAmount: 5 });
  });

  it.each(['abc', '0', '-3', '100001'])('refuses amount %s as USAGE', async (amountUsd) => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(200, { url: CHECKOUT });
    const err = await catchCliError(
      fund(makeCtx(), { provider, fetchImpl, wait: false, open: false, amountUsd }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  it('accepts the hosted Coinbase checkout host', async () => {
    const { provider } = fakeProvider();
    const res = await fund(makeCtx(), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      open: false,
    });
    expect(res.data).toMatchObject({ checkoutUrl: CHECKOUT });
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
      fund(makeCtx({ isTTY: true }), { provider, fetchImpl, wait: false, openUrl }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['https://tenjin.sh.evil.example/fund?amount=5#tok'],
    ['http://tenjin.sh/fund?amount=5#tok'],
    ['https://tenjin.blog/fund?amount=5#tok'],
    ['https://evil.example/fund?amount=5#tok'],
  ])('refuses a lookalike or off-allowlist host (%s)', async (url) => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(200, { url });
    const openUrl = vi.fn(async () => true);
    const err = await catchCliError(
      fund(makeCtx({ isTTY: true }), { provider, fetchImpl, wait: false, openUrl }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
    expect(err.message).toContain(`${EXPECTED_FUND_HOST} or pay.coinbase.com`);
    expect(openUrl).not.toHaveBeenCalled();
    expect(stderr.join('')).not.toContain('tok');
  });

  describe('the Tenjin fund page link', () => {
    const PAGE = `${EXPECTED_FUND_ORIGIN}/fund?amount=20#secret-token`;

    it('accepts the production host and sends the preset amount in the body', async () => {
      const { provider, address } = fakeProvider();
      const { fetchImpl, calls } = stubFetch(200, { url: PAGE });
      const res = await fund(makeCtx(), {
        provider,
        fetchImpl,
        wait: false,
        open: false,
        amountUsd: '20',
      });
      expect(calls[0]!.body).toMatchObject({ address, presetAmount: 20 });
      expect(res.data).toMatchObject({ checkoutUrl: PAGE, presetAmount: 20 });
    });

    it('opens the full URL with its fragment and prints it whole', async () => {
      const { provider } = fakeProvider();
      const openUrl = vi.fn(async () => true);
      await fund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        wait: false,
        openUrl,
      });
      expect(openUrl).toHaveBeenCalledWith(PAGE);
      const out = stderr.join('');
      expect(out).toContain(PAGE);
      expect(out).not.toContain('#…');
    });

    it('prints the whole link when it will not open it', async () => {
      const { provider } = fakeProvider();
      const piped = vi.fn(async () => true);
      await fund(makeCtx({ isTTY: false }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        wait: false,
        openUrl: piped,
        env: {},
      });
      expect(piped).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain(PAGE);

      stderr.length = 0;
      await fund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        wait: false,
        open: false,
      });
      expect(stderr.join('')).toContain(PAGE);
    });

    it('opens the page for an agent under a harness, whose shell has no terminal', async () => {
      // An explicitly requested wallet fund command still opens the browser.
      const { provider } = fakeProvider();
      const openUrl = vi.fn(async () => true);
      const res = await fund(makeCtx({ isTTY: false }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        openUrl,
        env: { CLAUDECODE: '1' },
      });
      expect(openUrl).toHaveBeenCalledWith(PAGE);
      // Still no poll: the envelope carrying the link must not wait on it.
      expect(res.data).toMatchObject({ opened: true, pollStatus: 'skipped' });
    });

    it.each([{ CLAUDECODE: '1' }, { CODEX_SESSION_ID: 'session' }])(
      'returns an unopened checkout link with --no-open under an agent harness %j',
      async (env) => {
        const { provider } = fakeProvider();
        const openUrl = vi.fn(async () => true);
        const res = await fund(makeCtx({ isTTY: false }), {
          provider,
          fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
          open: false,
          wait: false,
          amountUsd: '5',
          openUrl,
          env,
        });
        expect(openUrl).not.toHaveBeenCalled();
        expect(res.data).toMatchObject({
          checkoutUrl: PAGE,
          opened: false,
          funded: false,
          pollStatus: 'skipped',
        });
        expect(stderr.join('')).toContain(PAGE);
      },
    );

    it('prints the whole link when the browser could not be opened', async () => {
      const { provider } = fakeProvider();
      await fund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        wait: false,
        openUrl: async () => false,
      });
      expect(stderr.join('')).toContain(PAGE);
    });

    it('polls for the balance after opening the link', async () => {
      const { provider } = fakeProvider();
      mockedBalance
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(20_000_000n);
      const sleep = vi.fn(async () => {});
      const res = await fund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: PAGE }).fetchImpl,
        openUrl: async () => true,
        sleep,
        pollIntervalMs: 1,
        pollTimeoutMs: 60000,
      });
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(res.data).toMatchObject({
        funded: true,
        pollStatus: 'arrived',
        balance: { atomic: '20000000', usd: '20' },
      });
    });
  });

  it('maps region_not_supported to REFUSED (exit 3)', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = stubFetch(403, {
      error: { code: 'region_not_supported', message: 'no' },
    });
    const err = await catchCliError(
      fund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
  });

  it('maps 429 to RATE_LIMITED and 503 to API_UNREACHABLE', async () => {
    const { provider } = fakeProvider();
    const limited = await catchCliError(
      fund(makeCtx(), {
        provider,
        fetchImpl: stubFetch(429, { error: { code: 'rate_limited' } }).fetchImpl,
        wait: false,
        open: false,
      }),
    );
    expect(limited.code).toBe('RATE_LIMITED');

    const unconfigured = await catchCliError(
      fund(makeCtx(), {
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
      fund(makeCtx(), { provider, fetchImpl, wait: false, open: false }),
    );
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('opens the browser at a TTY and skips it when piped or --no-open', async () => {
    const { provider } = fakeProvider();
    const openUrl = vi.fn(async () => true);
    await fund(makeCtx({ isTTY: true }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      openUrl,
    });
    expect(openUrl).toHaveBeenCalledWith(CHECKOUT);

    openUrl.mockClear();
    await fund(makeCtx({ isTTY: false }), {
      provider,
      fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
      wait: false,
      openUrl,
      env: {},
    });
    await fund(makeCtx({ isTTY: true }), {
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
    const res = await fund(makeCtx({ isTTY: true }), {
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
    expect((res.data as { nextStep: string }).nextStep).toContain('Continue the original task');
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
      const res = await fund(makeCtx({ isTTY: true }), {
        provider,
        fetchImpl: stubFetch(200, { url: CHECKOUT }).fetchImpl,
        open: false,
        sleep,
        pollIntervalMs: 10,
        pollTimeoutMs: 30,
      });
      expect(sleep).toHaveBeenCalledTimes(3);
      // One baseline, then every other round (the public RPC rate-limits).
      expect(mockedBalance).toHaveBeenCalledTimes(3);
      expect(res.data).toMatchObject({ funded: false, pollStatus: 'timed-out' });
      expect(res.humanLines?.join(' ')).toContain('`tenjin balance --wait`');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips polling when the baseline read fails, instead of blocking funding', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockRejectedValue(new Error('rpc down'));
    const res = await fund(makeCtx({ isTTY: true }), {
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
    expect(res.humanLines?.join(' ')).toContain("Couldn't read your balance");
    expect(mockedBalance).toHaveBeenCalledTimes(1);
  });
});

/** A Tenjin /fund link whose token expires at `exp` (ms epoch). */
function pageLink(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ address: '0xabc', exp })).toString('base64url');
  return `${EXPECTED_FUND_ORIGIN}/fund?amount=5#${payload}.c2ln`;
}

/** The link route mints `links` in turn; the status route answers from `statuses`. */
function fundServer(links: string[], statuses: [number, unknown][] = [[404, {}]]) {
  const mints: Captured[] = [];
  let statusCalls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/fund/link')) {
      mints.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const link = links[Math.min(mints.length - 1, links.length - 1)]!;
      return new Response(JSON.stringify({ url: link }), { status: 200 });
    }
    const [status, body] = statuses[Math.min(statusCalls, statuses.length - 1)]!;
    statusCalls++;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, mints, statusCalls: () => statusCalls };
}

describe('runFund: the link, its context and its status', () => {
  it('says where the link was asked for: the terminal, an agent, or install', async () => {
    const { provider } = fakeProvider();
    const server = fundServer([CHECKOUT]);
    await fund(makeCtx(), { provider, fetchImpl: server.fetchImpl, wait: false, open: false });
    await fund(makeCtx(), {
      provider,
      fetchImpl: server.fetchImpl,
      wait: false,
      open: false,
      env: { CLAUDECODE: '1' },
    });
    await fund(makeCtx(), {
      provider,
      fetchImpl: server.fetchImpl,
      wait: false,
      open: false,
      env: { CLAUDECODE: '1' },
      source: 'install',
    });
    expect(server.mints.map((m) => (m.body as { source: string }).source)).toEqual([
      'terminal',
      'agent',
      'install',
    ]);
  });

  it('sends the waiting call as `need`, and refuses --for without --price', async () => {
    const { provider } = fakeProvider();
    const server = fundServer([CHECKOUT]);
    const res = await fund(makeCtx(), {
      provider,
      fetchImpl: server.fetchImpl,
      wait: false,
      open: false,
      forLabel: 'X post read',
      priceUsd: '0.006',
    });
    expect(server.mints[0]!.body).toMatchObject({
      need: { label: 'X post read', priceUsd: 0.006 },
    });
    // The agent says what the money is for.
    expect((res.data as { nextStep: string }).nextStep).toContain('X post read, $0.006 a call');
    const err = await catchCliError(
      fund(makeCtx(), { provider, fetchImpl: server.fetchImpl, wait: false, forLabel: 'X' }),
    );
    expect(err.code).toBe('USAGE');
    expect(server.mints).toHaveLength(1);
  });

  it('never fails over the device name: none is sent when it cannot be read', async () => {
    const { provider } = fakeProvider();
    const server = fundServer([CHECKOUT]);
    await fund(makeCtx(), {
      provider,
      fetchImpl: server.fetchImpl,
      wait: false,
      open: false,
      deviceName: async () => {
        throw new Error('scutil gone');
      },
    });
    expect(server.mints[0]!.body).not.toHaveProperty('deviceName');
  });

  it('waits on a payment already on its way instead of opening a second checkout', async () => {
    const { provider } = fakeProvider();
    const link = pageLink(Date.now() + 600_000);
    mockedBalance.mockResolvedValue(0n);
    const first = fundServer([link]);
    await fund(makeCtx(), { provider, fetchImpl: first.fetchImpl, wait: false, open: false });
    expect(first.mints).toHaveLength(1);

    // The page reported a payment in progress; the balance has not moved yet.
    const again = fundServer(
      [pageLink(Date.now() + 600_000)],
      [[200, { state: 'paying', updatedAt: 'x' }]],
    );
    const openUrl = vi.fn(async () => true);
    const res = await fund(makeCtx(), {
      provider,
      fetchImpl: again.fetchImpl,
      wait: false,
      openUrl,
      env: { CLAUDECODE: '1' },
    });
    expect(again.mints).toHaveLength(0);
    expect(openUrl).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ checkoutUrl: link, paymentInFlight: true, status: 'paying' });
    expect((res.data as { nextStep: string }).nextStep).toContain('already on its way');

    // Once that money is in the balance, a rerun is a new top-up.
    mockedBalance.mockResolvedValue(5_000_000n);
    const after = fundServer([CHECKOUT], [[200, { state: 'paid', updatedAt: 'x' }]]);
    await fund(makeCtx(), { provider, fetchImpl: after.fetchImpl, wait: false, open: false });
    expect(after.mints).toHaveLength(1);
  });

  it('offers a fresh link with r when one expires with nothing paid at a terminal', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    let clock = 1_000_000;
    const server = fundServer(
      [pageLink(clock + 4_000), pageLink(clock + 600_000)],
      [[200, { state: 'opened', updatedAt: 'x' }]],
    );
    const keys = ['r', 'q'];
    const readKey = vi.fn(async () => keys.shift() ?? null);
    const res = await fund(makeCtx({ isTTY: true, json: false }), {
      provider,
      fetchImpl: server.fetchImpl,
      openUrl: async () => true,
      readKey,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollTimeoutMs: 20_000,
    });
    expect(server.mints).toHaveLength(2);
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).toContain('The checkout link expired. Nothing was charged.');
    expect(res.data).toMatchObject({ funded: false, checkoutUrl: pageLink(1_000_000 + 600_000) });
  });

  it('--crypto shows the address with its rule and watches the balance, minting nothing', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValueOnce(210_000n).mockResolvedValueOnce(5_210_000n);
    const server = fundServer([CHECKOUT]);
    const res = await fund(makeCtx({ isTTY: true, json: false, columns: 80 }), {
      provider,
      fetchImpl: server.fetchImpl,
      crypto: true,
      sleep: async () => {},
      pollIntervalMs: 1,
    });
    expect(server.mints).toHaveLength(0);
    const out = stderr.join('');
    expect(out).toContain('Only USDC, only on the Base network.');
    // The address in one piece, and its two ends to check it by.
    expect(out).toContain(address);
    expect(out).toContain(`starts ${address.slice(0, 6)} · ends ${address.slice(-4)}`);
    expect(out).toContain('USDC on Base (eip155:8453)');
    expect(res.data).toMatchObject({ crypto: true, funded: true, added: { usd: '5' } });
  });
});

describe('a hosted checkout, which has no payment status', () => {
  // A Coinbase-hosted link carries no token, so nothing can report its
  // payment; the balance it was issued at is what an arrival is measured from.
  it('counts a payment that lands before `tenjin balance --wait` starts', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const server = fundServer([CHECKOUT]);
    await fund(makeCtx(), { provider, fetchImpl: server.fetchImpl, wait: false, open: false });

    // Paid in the browser before the agent's background wait began.
    mockedBalance.mockResolvedValue(5_000_000n);
    let clock = Date.now();
    const res = await runBalance(makeCtx(), {
      provider,
      wait: true,
      waitMs: 10_000,
      fetchImpl: server.fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(res.data).toMatchObject({ arrived: true, added: { usd: '5' } });
    // No status route is asked for a link without a token.
    expect(server.statusCalls()).toBe(0);
  });
});
