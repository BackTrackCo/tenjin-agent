import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { WalletProvider } from '../lib/wallet';

// Balance is the only path that hits the chain; mock the RPC read so the whole
// suite stays offline and deterministic. viem's key derivation stays real.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import {
  runWalletCreate,
  runWalletShow,
  runWalletBalance,
  runWalletImport,
  type ReadStdin,
} from './wallet';

const mockedBalance = vi.mocked(getUsdcBalance);
const isWindows = process.platform === 'win32';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-wallet-'));
  // A nested, not-yet-created dir so the atomic writer creates it 0700 itself
  // (mkdtemp's own dir would mask that).
  dataDir = join(tmp, '.tenjin');
  mockedBalance.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    return err as CliError;
  }
  throw new Error('expected a CliError to be thrown');
}

const walletFile = () => join(dataDir, 'wallet.json');
const readStored = async () =>
  JSON.parse(await readFile(walletFile(), 'utf8')) as { address: string; privateKey: string };

/** A remote-style provider: describe() works, getSigner() must never be called by show/balance. */
function fakeRemoteProvider(
  address: Address,
  opts: { describeRejects?: boolean } = {},
): { provider: WalletProvider; getSigner: ReturnType<typeof vi.fn> } {
  const getSigner = vi.fn(async () => {
    throw new Error('getSigner must not be called by show/balance');
  });
  const provider: WalletProvider = {
    id: 'fake-remote',
    describe: async () => {
      if (opts.describeRejects) throw new Error('remote describe failed');
      return {
        address,
        provider: 'fake-remote',
        credentialSource: 'remote',
        policyEnforcement: 'provider',
      };
    },
    getSigner,
    // A remote provider has no local file: no path, no perms/shadow warnings.
    diagnostics: async () => ({ warnings: [] }),
  };
  return { provider, getSigner };
}

describe('runWalletCreate', () => {
  it.skipIf(isWindows)('writes a 0600 wallet file inside a 0700 dir', async () => {
    await runWalletCreate(makeCtx());
    expect((await stat(walletFile())).mode & 0o777).toBe(0o600);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });

  it('stores a key that derives the reported address', async () => {
    const res = await runWalletCreate(makeCtx());
    const address = (res.data as { address: string }).address;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const stored = await readStored();
    expect(privateKeyToAccount(stored.privateKey as `0x${string}`).address).toBe(address);
    expect(res.data).toMatchObject({ provider: 'local', policyEnforcement: 'client-only' });
  });

  it('emits the exact funding line', async () => {
    const res = await runWalletCreate(makeCtx());
    expect(res.humanLines).toContain('Send USDC on Base. $5 covers ~50 typical resources.');
  });

  it('refuses to overwrite an existing wallet (WALLET_EXISTS, exit 3)', async () => {
    await runWalletCreate(makeCtx());
    const err = await catchCliError(runWalletCreate(makeCtx()));
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.exitCode).toBe(3);
    expect(err.fix).toContain(walletFile());
  });

  it('warns about env shadowing in both data and human lines', async () => {
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());
    const res = await runWalletCreate(makeCtx());
    const warnings = (res.data as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('TENJIN_WALLET_KEY'))).toBe(true);
    expect(res.humanLines?.some((l) => l.includes('TENJIN_WALLET_KEY'))).toBe(true);
  });

  // The friendly pre-check can pass in both racers before either writes; the
  // exclusive write is the real guard, so exactly one wins and the stored key is
  // the winner's, never silently clobbered.
  it('two concurrent creates: one wins, the other is WALLET_EXISTS, no clobber', async () => {
    const ctx = makeCtx();
    const results = await Promise.allSettled([runWalletCreate(ctx), runWalletCreate(ctx)]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(((losers[0] as PromiseRejectedResult).reason as CliError).code).toBe('WALLET_EXISTS');
    const winner = (winners[0] as PromiseFulfilledResult<{ data: { address: string } }>).value.data;
    expect((await readStored()).address).toBe(winner.address);
  });

  it('concurrent create vs import: one wins, the other is WALLET_EXISTS, no clobber', async () => {
    const ctx = makeCtx();
    const key = generatePrivateKey();
    const results = await Promise.allSettled([
      runWalletCreate(ctx),
      runWalletImport({ fromEnv: false }, ctx, async () => key),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(((losers[0] as PromiseRejectedResult).reason as CliError).code).toBe('WALLET_EXISTS');
    const winner = (winners[0] as PromiseFulfilledResult<{ data: { address: string } }>).value.data;
    expect((await readStored()).address).toBe(winner.address);
  });
});

describe('runWalletShow', () => {
  it('returns the describe() shape from the file provider', async () => {
    const created = await runWalletCreate(makeCtx());
    const res = await runWalletShow(makeCtx());
    expect(res.data).toMatchObject({
      address: (created.data as { address: string }).address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
      walletPath: walletFile(),
    });
  });

  it('never leaks the private key in the serialized result', async () => {
    await runWalletCreate(makeCtx());
    const { privateKey } = await readStored();
    const res = await runWalletShow(makeCtx());
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain('privateKey');
  });

  it.skipIf(isWindows)('warns when file permissions are not 0600', async () => {
    await runWalletCreate(makeCtx());
    await chmod(walletFile(), 0o644);
    const res = await runWalletShow(makeCtx());
    const warnings = (res.data as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('permissions'))).toBe(true);
  });

  it('reports env credential source and shadow warning when env shadows the file', async () => {
    await runWalletCreate(makeCtx());
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());
    const res = await runWalletShow(makeCtx());
    const data = res.data as { credentialSource: string; warnings: string[] };
    expect(data.credentialSource).toBe('env');
    expect(data.warnings.some((w) => w.includes('shadows'))).toBe(true);
  });

  it('does not call getSigner and returns the provider posture (fake remote)', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider, getSigner } = fakeRemoteProvider(address);
    const res = await runWalletShow(makeCtx(), { provider });
    expect(res.data).toMatchObject({
      address,
      policyEnforcement: 'provider',
      provider: 'fake-remote',
    });
    expect(getSigner).not.toHaveBeenCalled();
  });

  it('normalizes a provider describe() rejection to PROVIDER_ERROR', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider } = fakeRemoteProvider(address, { describeRejects: true });
    const err = await catchCliError(runWalletShow(makeCtx(), { provider }));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.exitCode).toBe(1);
  });

  it('remote provider ignores a stale local wallet.json + env key (no contamination, no leak)', async () => {
    // A local wallet exists with wrong perms and an env key is set — all of which
    // would warn if show consulted local state. With a remote provider active, show
    // must render ONLY the provider's own diagnostics: remote address, no local
    // path, no warnings, and never the on-disk key.
    await runWalletCreate(makeCtx());
    await chmod(walletFile(), 0o644);
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());
    const { privateKey } = await readStored();

    const remoteAddress = privateKeyToAccount(generatePrivateKey()).address;
    const { provider } = fakeRemoteProvider(remoteAddress);
    const res = await runWalletShow(makeCtx(), { provider });

    const data = res.data as { address: string; walletPath?: string; warnings: string[] };
    expect(data.address).toBe(remoteAddress);
    expect(data.walletPath).toBeUndefined();
    expect(data.warnings).toEqual([]);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain('privateKey');
  });
});

describe('runWalletBalance', () => {
  it('returns dual-form money from the on-chain read', async () => {
    await runWalletCreate(makeCtx());
    mockedBalance.mockResolvedValue(250000n);
    const res = await runWalletBalance(makeCtx());
    expect((res.data as { balance: unknown }).balance).toEqual({ atomic: '250000', usd: '0.25' });
  });

  it('maps an RPC failure to RPC_ERROR with a config fix', async () => {
    await runWalletCreate(makeCtx());
    mockedBalance.mockRejectedValue(new Error('rpc down'));
    const err = await catchCliError(runWalletBalance(makeCtx()));
    expect(err.code).toBe('RPC_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.fix).toContain('tenjin config set rpcUrl');
  });

  it('reads balance keylessly through a fake remote provider', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider, getSigner } = fakeRemoteProvider(address);
    mockedBalance.mockResolvedValue(1000000n);
    const res = await runWalletBalance(makeCtx(), { provider });
    expect((res.data as { balance: { usd: string } }).balance.usd).toBe('1');
    expect(getSigner).not.toHaveBeenCalled();
  });
});

describe('runWalletImport', () => {
  const stdinOf =
    (value: string | null): ReadStdin =>
    async () =>
      value;

  it('imports a piped key and persists it', async () => {
    const key = generatePrivateKey();
    const res = await runWalletImport({ fromEnv: false }, makeCtx(), stdinOf(key));
    const address = privateKeyToAccount(key).address;
    expect(res.data).toMatchObject({ address, source: 'stdin', walletPath: walletFile() });
    expect((await readStored()).privateKey).toBe(key);
  });

  it('rejects an invalid key (WALLET_INVALID_KEY)', async () => {
    const err = await catchCliError(
      runWalletImport({ fromEnv: false }, makeCtx(), stdinOf('not-a-key')),
    );
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('exits USAGE (2) when stdin is a TTY with no input', async () => {
    const err = await catchCliError(runWalletImport({ fromEnv: false }, makeCtx(), stdinOf(null)));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(err.fix).toContain('--from-env');
  });

  it('refuses to overwrite an existing wallet (WALLET_EXISTS)', async () => {
    await runWalletCreate(makeCtx());
    const err = await catchCliError(
      runWalletImport({ fromEnv: false }, makeCtx(), stdinOf(generatePrivateKey())),
    );
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.exitCode).toBe(3);
  });

  it('reads the key from TENJIN_WALLET_KEY with --from-env', async () => {
    const key = generatePrivateKey();
    vi.stubEnv('TENJIN_WALLET_KEY', key);
    const res = await runWalletImport({ fromEnv: true }, makeCtx(), stdinOf(null));
    expect(res.data).toMatchObject({ address: privateKeyToAccount(key).address, source: 'env' });
  });

  it('exits USAGE when --from-env is set but the env var is missing', async () => {
    const err = await catchCliError(runWalletImport({ fromEnv: true }, makeCtx(), stdinOf(null)));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});
