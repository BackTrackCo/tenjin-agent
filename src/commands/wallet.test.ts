import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { WalletProvider } from '../lib/wallet';
import type { ExecFn } from '../lib/wallet/passphrase';

// Balance is the only path that hits the chain; mock the RPC read so the whole
// suite stays offline and deterministic. viem's key derivation stays real.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import { runWalletCreate, runWalletShow, runWalletBalance } from './wallet';

const mockedBalance = vi.mocked(getUsdcBalance);
const isWindows = process.platform === 'win32';
const PASSPHRASE = 'test-passphrase-123';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-wallet-'));
  // A nested, not-yet-created dir so the atomic writer creates it 0700 itself.
  dataDir = join(tmp, '.tenjin');
  mockedBalance.mockReset();
  // Encrypt via the env passphrase by default: deterministic, no keychain/TTY.
  vi.stubEnv('TENJIN_WALLET_PASSPHRASE', PASSPHRASE);
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
  JSON.parse(await readFile(walletFile(), 'utf8')) as {
    schemaVersion: number;
    address: string;
    keystore: { version: number };
  };

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

  it('stores an encrypted keystore v2 record and never the raw key', async () => {
    const res = await runWalletCreate(makeCtx());
    const address = (res.data as { address: string }).address;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const stored = await readStored();
    expect(stored.schemaVersion).toBe(2);
    expect(stored.keystore.version).toBe(3);
    expect(stored.address).toBe(address);
    expect(res.data).toMatchObject({
      provider: 'local',
      policyEnforcement: 'client-only',
      keyStorage: 'encrypted (keystore v3, scrypt)',
      passphraseSource: 'env',
    });
    // The plaintext private key must never be written to disk.
    const raw = await readFile(walletFile(), 'utf8');
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(raw).not.toContain('privateKey');
  });

  it('emits the exact funding line', async () => {
    const res = await runWalletCreate(makeCtx());
    expect(res.humanLines).toContain('Send USDC on Base. $5 covers ~50 typical resources.');
  });

  it('reports that the key is stored encrypted', async () => {
    const res = await runWalletCreate(makeCtx());
    expect(res.humanLines?.some((l) => l.includes('keystore v3'))).toBe(true);
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

  it('auto-generates and stores a keychain passphrase on macOS when env is unset', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', ''); // clear the env passphrase
    let seenArgs: string[] | undefined;
    let seenStdin: string | undefined;
    const exec: ExecFn = async (file, args, stdin) => {
      // The write goes through `security -i`: the secret is on stdin, never argv.
      expect(file).toBe('security');
      seenArgs = args;
      seenStdin = stdin;
      return { stdout: '', stderr: '' };
    };
    const res = await runWalletCreate(makeCtx(), {
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    expect((res.data as { passphraseSource: string }).passphraseSource).toBe('keychain');
    expect(res.humanLines?.some((l) => l.includes('keychain'))).toBe(true);
    // argv is exactly ['-i']; the generated base64url passphrase lives only in stdin.
    expect(seenArgs).toEqual(['-i']);
    const stored = seenStdin?.match(/-w '([^']+)'/)?.[1];
    expect(stored).toBeDefined();
    expect((stored as string).length).toBeGreaterThanOrEqual(32);
    expect(stored as string).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('errors USAGE when no passphrase source is available (headless, non-mac)', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const err = await catchCliError(
      runWalletCreate(makeCtx(), { passphrase: { platform: 'linux', isTTY: false } }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.fix).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  // The friendly pre-check can pass in both racers before either writes; the
  // exclusive write is the real guard, so exactly one wins and no key is clobbered.
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
});

describe('runWalletShow', () => {
  it('returns the describe() shape plus custody posture from the file provider', async () => {
    const created = await runWalletCreate(makeCtx());
    const res = await runWalletShow(makeCtx());
    expect(res.data).toMatchObject({
      address: (created.data as { address: string }).address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
      walletPath: walletFile(),
      keyStorage: 'encrypted (keystore v3, scrypt)',
      passphraseSource: 'TENJIN_WALLET_PASSPHRASE',
    });
  });

  it('does not decrypt and never leaks a private key', async () => {
    await runWalletCreate(makeCtx());
    const res = await runWalletShow(makeCtx());
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it('rejects a pre-encryption v1 wallet file with the recreate fix', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      walletFile(),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'local',
        address: privateKeyToAccount(generatePrivateKey()).address,
        privateKey: generatePrivateKey(),
        createdAt: new Date().toISOString(),
      }),
    );
    const err = await catchCliError(runWalletShow(makeCtx()));
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain('predates encrypted storage');
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
    await runWalletCreate(makeCtx());
    await chmod(walletFile(), 0o644);
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());

    const remoteAddress = privateKeyToAccount(generatePrivateKey()).address;
    const { provider } = fakeRemoteProvider(remoteAddress);
    const res = await runWalletShow(makeCtx(), { provider });

    const data = res.data as {
      address: string;
      walletPath?: string;
      keyStorage?: string;
      warnings: string[];
    };
    expect(data.address).toBe(remoteAddress);
    expect(data.walletPath).toBeUndefined();
    expect(data.keyStorage).toBeUndefined();
    expect(data.warnings).toEqual([]);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
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
