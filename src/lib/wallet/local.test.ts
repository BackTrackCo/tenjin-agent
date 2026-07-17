import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CliError } from '../errors';
import { walletPath } from '../paths';
import { readWalletRecord, writeWalletRecord, type WalletRecord } from './store';
import { createLocalProvider, createLocalWallet } from './local';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-local-'));
  dataDir = join(tmp, '.tenjin');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function seedFileWallet(): Promise<{ address: string; privateKey: `0x${string}` }> {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const record: WalletRecord = {
    schemaVersion: 1,
    provider: 'local',
    address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  await writeWalletRecord(dataDir, record);
  return { address, privateKey };
}

describe('createLocalProvider.describe', () => {
  it('describes a file wallet without deriving from the key', async () => {
    const { address } = await seedFileWallet();
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    expect(await provider.describe()).toEqual({
      address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    });
  });

  it('describes an env wallet, deriving the address from the env key', async () => {
    const key = generatePrivateKey();
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: key } });
    const desc = await provider.describe();
    expect(desc.credentialSource).toBe('env');
    expect(desc.address).toBe(privateKeyToAccount(key).address);
  });

  it('env key takes precedence over the file wallet', async () => {
    await seedFileWallet();
    const envKey = generatePrivateKey();
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: envKey } });
    const desc = await provider.describe();
    expect(desc.credentialSource).toBe('env');
    expect(desc.address).toBe(privateKeyToAccount(envKey).address);
  });

  it('throws WALLET_MISSING when neither env nor file exists', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
    expect(err.fix).toContain('tenjin wallet create');
  });

  it('throws WALLET_INVALID_KEY for a malformed env key', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: 'nope' } });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('rejects a file record whose stored address does not match its key', async () => {
    // Schema-valid but tampered: the address is a different account's.
    const privateKey = generatePrivateKey();
    const record: WalletRecord = {
      schemaVersion: 1,
      provider: 'local',
      address: privateKeyToAccount(generatePrivateKey()).address,
      privateKey,
      createdAt: new Date().toISOString(),
    };
    await writeWalletRecord(dataDir, record);
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.fix).toContain('TENJIN_WALLET_KEY');
  });

  it('rejects a file record whose key is outside the curve order', async () => {
    const record: WalletRecord = {
      schemaVersion: 1,
      provider: 'local',
      address: privateKeyToAccount(generatePrivateKey()).address,
      // Passes the hex-format regex but exceeds the secp256k1 scalar range.
      privateKey: `0x${'f'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    };
    await writeWalletRecord(dataDir, record);
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });
});

describe('createLocalProvider.getSigner', () => {
  it('returns a signer whose address matches and whose signMessage works', async () => {
    const { address } = await seedFileWallet();
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const signer = await provider.getSigner();
    expect(signer.address).toBe(address);
    const sig = await signer.signMessage({ message: 'tenjin' });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it('throws WALLET_MISSING with no credential', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
  });
});

describe('createLocalWallet', () => {
  it('createLocalWallet persists a key that derives the reported address', async () => {
    const { address, walletPath: path } = await createLocalWallet(dataDir);
    expect(path).toBe(walletPath(dataDir));
    const record = await readWalletRecord(dataDir);
    expect(privateKeyToAccount(record!.privateKey as Hex).address).toBe(address);
  });

  it('createLocalWallet refuses to clobber an existing wallet (WALLET_EXISTS)', async () => {
    await createLocalWallet(dataDir);
    const err = (await createLocalWallet(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.exitCode).toBe(3);
  });
});
