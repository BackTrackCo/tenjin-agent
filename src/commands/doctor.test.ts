import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { runDoctor } from './doctor';
import type { CheckResult } from './doctor';
import { getUsdcBalance } from '../lib/usdc';
import { CliError } from '../lib/errors';
import { fakeRecord } from '../lib/wallet/test-support';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';
import type { WalletProvider } from '../lib/wallet';

// doctor loads viem's balance read lazily; the mock keeps every test off-chain.
vi.mock('../lib/usdc', () => ({ getUsdcBalance: vi.fn() }));
const balanceMock = vi.mocked(getUsdcBalance);

const OPENAPI_OK = { openapi: '3.1.0', info: { title: 'Tenjin', version: '0.1.0' } };
const ARTICLES_OK = { items: [{ id: 'a1' }], nextCursor: null };
// doctor reads the wallet file's cleartext top-level address without decrypting,
// so the fixture just needs a real address; PRIVATE_KEY is kept only to assert it
// never appears in any output.
const PRIVATE_KEY = `0x${'de'.repeat(32)}` as `0x${string}`;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

let dir: string;
let prevWalletKey: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-doctor-'));
  balanceMock.mockReset();
  // The wallet provider resolves against process.env, so keep it hermetic: a
  // stray TENJIN_WALLET_KEY would shadow the file-based tests below.
  prevWalletKey = process.env.TENJIN_WALLET_KEY;
  delete process.env.TENJIN_WALLET_KEY;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevWalletKey === undefined) delete process.env.TENJIN_WALLET_KEY;
  else process.env.TENJIN_WALLET_KEY = prevWalletKey;
});

function captureIo(isTTY = false): { io: Io; stderr: () => string } {
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk([]), stderr: mk(err), isTTY };
  return { io, stderr: () => err.join('') };
}

function ctxFor(): CommandContext {
  return {
    flags: { json: false, timeout: 5000, baseUrl: undefined },
    dataDir: dir,
    io: captureIo().io,
  };
}

/** A fetch stub that routes by URL substring; a mapped Error value is thrown. */
function routeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [needle, value] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (value instanceof Error) throw value;
      const { body, status = 200 } = value as { body: unknown; status?: number };
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const healthyFetch = routeFetch({
  '/openapi.json': { body: OPENAPI_OK },
  '/api/articles': { body: ARTICLES_OK },
});

function find(checks: CheckResult[], name: string): CheckResult {
  const c = checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named ${name}`);
  return c;
}

async function writeWallet(mode: number): Promise<void> {
  const path = join(dir, 'wallet.json');
  await writeFile(path, JSON.stringify(fakeRecord({ address: ADDRESS })));
  await chmod(path, mode);
}

describe('runDoctor — passing outcomes', () => {
  it('all required checks green, no wallet: status pass with a warn wallet check', async () => {
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'api-contract').detail).toContain('0.1.0');
    expect(find(data.checks, 'wallet').status).toBe('warn');
    expect(res.humanLines).toHaveLength(data.checks.length + 1); // wallet warn adds a fix line
  });

  it('wallet present but not 0600: warns on perms, still passes', async () => {
    await writeWallet(0o644);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    // Perms surface via the provider's diagnostics as a wallet-custody warn,
    // with the fix inline in the warning text.
    const perms = data.checks.find(
      (c) => c.name === 'wallet-custody' && c.detail.includes('chmod 600'),
    );
    expect(perms?.status).toBe('warn');
    // The private key must never reach any output field.
    expect(JSON.stringify(res.data)).not.toContain(PRIVATE_KEY);
  });

  it('env key shadows the file: env-shadow warn AND balance probes the env address', async () => {
    // Regression for the wrong-wallet bug: doctor must diagnose the ACTIVE wallet
    // (the env key), not the file it shadows. The env key derives a different
    // address than the file's, so the balance probe address proves which wins.
    await writeWallet(0o600); // file address = ADDRESS
    const envKey = generatePrivateKey();
    const envAddress = privateKeyToAccount(envKey).address;
    expect(envAddress).not.toBe(ADDRESS);
    process.env.TENJIN_WALLET_KEY = envKey; // provider reads process.env
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      env: { TENJIN_WALLET_KEY: envKey },
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    const shadow = data.checks.find(
      (c) => c.name === 'wallet-custody' && c.detail.includes('shadows the wallet file'),
    );
    expect(shadow?.status).toBe('warn');
    expect(find(data.checks, 'wallet').detail).toContain(envAddress);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(envAddress);
  });

  it('zero balance warns with the funding fix', async () => {
    await writeWallet(0o600);
    balanceMock.mockResolvedValue(0n);
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('warn');
    expect(balance.fix).toContain('Send USDC on Base');
  });

  it('a positive balance is an ok check with dual-form amount', async () => {
    await writeWallet(0o600);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('ok');
    expect(balance.detail).toContain('5');
    expect(balance.detail).toContain('5000000');
  });

  it('an RPC failure warns, never fails doctor', async () => {
    await writeWallet(0o600);
    balanceMock.mockRejectedValue(new Error('rpc down'));
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'balance').status).toBe('warn');
  });

  it('a corrupt wallet file warns, never fails doctor', async () => {
    await writeFile(join(dir, 'wallet.json'), '{ not json');
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    const wallet = find(data.checks, 'wallet');
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('not valid JSON');
    // A custody problem yields no address, so no balance check is added.
    expect(data.checks.some((c) => c.name === 'balance')).toBe(false);
  });

  it('read-path probe sends no q parameter (never fabricate search demand)', async () => {
    // The server logs every nonblank first-page `q` as agent search demand, so a
    // health probe must never inject one. This assertion must never regress.
    let readPathUrl: string | undefined;
    const capturing: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/articles')) readPathUrl = url;
      const body = url.includes('/openapi.json') ? OPENAPI_OK : ARTICLES_OK;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await runDoctor(ctxFor(), { env: {}, fetchImpl: capturing });
    expect(readPathUrl).toBeDefined();
    expect(new URL(readPathUrl as string).searchParams.has('q')).toBe(false);
  });
});

describe('runDoctor — required failures throw the mapped CliError', () => {
  async function catchDoctor(fetchImpl: typeof fetch): Promise<CliError> {
    const err = await runDoctor(ctxFor(), { env: {}, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }

  it('an unreachable API is API_UNREACHABLE and keeps the full check list', async () => {
    const rejecting = routeFetch({
      '/openapi.json': new TypeError('fetch failed'),
      '/api/articles': new TypeError('fetch failed'),
    });
    const err = await catchDoctor(rejecting);
    expect(err.code).toBe('API_UNREACHABLE');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'api-contract').status).toBe('fail');
  });

  it('a 200 with garbage JSON at openapi is CONTRACT_MISMATCH', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: 'garbage{' },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('a missing info.version at openapi is CONTRACT_MISMATCH', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: { openapi: '3.1.0', info: { title: 'x' } } },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('a 500 on the read path (openapi healthy) is API_UNREACHABLE', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: OPENAPI_OK },
        '/api/articles': { body: { error: {} }, status: 500 },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'api-contract').status).toBe('ok');
    expect(find(checks, 'read-path').status).toBe('fail');
  });

  it('invalid config JSON is CONFIG_INVALID (exit 2 by default mapping)', async () => {
    await writeFile(join(dir, 'config.json'), '{ not json');
    const err = await catchDoctor(healthyFetch);
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.exitCode).toBe(2);
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'config').status).toBe('fail');
  });
});

describe('runDoctor — injected remote provider', () => {
  function remoteProvider(address: Address): WalletProvider {
    return {
      id: 'fake-remote',
      describe: async () => ({
        address,
        provider: 'fake-remote',
        credentialSource: 'remote',
        policyEnforcement: 'provider',
      }),
      diagnostics: async () => ({ warnings: [] }),
      getSigner: async () => {
        throw new Error('doctor must never acquire a signer');
      },
    };
  }

  it('empty data dir: wallet check reports the remote address, balance probes it', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      env: {},
      fetchImpl: healthyFetch,
      provider: remoteProvider(address),
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'wallet').detail).toContain(address);
    expect(data.checks.filter((c) => c.name === 'wallet-custody')).toEqual([]);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(address);
  });

  it('stale local wallet + env key present: no local custody state leaks into the report', async () => {
    // The contamination regression: local file with bad perms AND an env key would
    // each warn under the local provider; with a remote provider active, doctor
    // must render only that provider's diagnostics.
    await writeWallet(0o644);
    process.env.TENJIN_WALLET_KEY = generatePrivateKey();
    const address = privateKeyToAccount(generatePrivateKey()).address;
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      env: { TENJIN_WALLET_KEY: process.env.TENJIN_WALLET_KEY },
      fetchImpl: healthyFetch,
      provider: remoteProvider(address),
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'wallet').detail).toContain(address);
    expect(data.checks.filter((c) => c.name === 'wallet-custody')).toEqual([]);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(address);
    expect(JSON.stringify(res.data)).not.toContain(PRIVATE_KEY);
  });
});
