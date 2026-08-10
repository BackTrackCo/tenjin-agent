import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { CliError } from '../errors';
import {
  createClawRouterProvider,
  discoverClawRouterWallet,
  type ClawRouterProviderDeps,
} from './clawrouter';
import type { ClawRouterWalletRecord } from './store';

let dir: string;
let keyPath: string;
let key: `0x${string}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-clawrouter-'));
  keyPath = join(dir, '.openclaw', 'blockrun', 'wallet.key');
  key = generatePrivateKey();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function writeKey(value: string = key): Promise<void> {
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${value}\n`, { mode: 0o600 });
}

function deps(env: NodeJS.ProcessEnv = {}): ClawRouterProviderDeps {
  return { walletKeyPath: keyPath, env };
}

function record(address = privateKeyToAccount(key).address): ClawRouterWalletRecord {
  return {
    schemaVersion: 3,
    provider: 'clawrouter',
    address,
    connectedAt: '2026-08-09T00:00:00.000Z',
  };
}

async function sourceSnapshot() {
  const [bytes, info] = await Promise.all([readFile(keyPath), stat(keyPath)]);
  return {
    bytes: bytes.toString('hex'),
    inode: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

describe('discoverClawRouterWallet', () => {
  it('uses the canonical wallet.key before BLOCKRUN_WALLET_KEY', async () => {
    await writeKey();
    const other = generatePrivateKey();

    const found = await discoverClawRouterWallet(deps({ BLOCKRUN_WALLET_KEY: other }));

    expect(found).toEqual({
      address: privateKeyToAccount(key).address,
      credentialSource: 'file',
    });
  });

  it('falls back to BLOCKRUN_WALLET_KEY only when wallet.key is absent', async () => {
    const found = await discoverClawRouterWallet(deps({ BLOCKRUN_WALLET_KEY: key }));
    expect(found).toEqual({
      address: privateKeyToAccount(key).address,
      credentialSource: 'env',
    });
  });

  it('refuses a malformed existing file instead of falling through to env', async () => {
    await writeKey('not-a-key');
    const err = (await discoverClawRouterWallet(
      deps({ BLOCKRUN_WALLET_KEY: generatePrivateKey() }),
    ).catch((cause) => cause)) as CliError;

    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain(keyPath);
  });
});

describe('createClawRouterProvider', () => {
  it('describes the pinned address without reading private key material', async () => {
    await writeKey();
    const readFileImpl = vi.fn(async () => {
      throw new Error('describe must not read the key');
    }) as unknown as NonNullable<ClawRouterProviderDeps['readFileImpl']>;
    const provider = createClawRouterProvider(record(), { ...deps(), readFileImpl });

    expect(await provider.describe()).toMatchObject({
      address: privateKeyToAccount(key).address,
      provider: 'clawrouter',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    });
    expect(readFileImpl).not.toHaveBeenCalled();
  });

  it('signs messages with the connected ClawRouter address', async () => {
    await writeKey();
    const sourceBefore = await sourceSnapshot();
    const provider = createClawRouterProvider(record(), deps());
    const signer = await provider.getSigner();
    const signature = await signer.signMessage({ message: 'tenjin test' });

    expect(await recoverMessageAddress({ message: 'tenjin test', signature })).toBe(
      privateKeyToAccount(key).address,
    );
    expect(await sourceSnapshot()).toEqual(sourceBefore);
  });

  it('refuses signer drift until the user explicitly reconnects', async () => {
    await writeKey();
    const provider = createClawRouterProvider(record(), deps());
    await writeKey(generatePrivateKey());
    const sourceBefore = await sourceSnapshot();

    const err = (await provider.getSigner().catch((cause) => cause)) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('wallet connect clawrouter --replace');
    expect(await sourceSnapshot()).toEqual(sourceBefore);
  });

  it('refuses raw transactions even when message signing is available', async () => {
    await writeKey();
    const signer = await createClawRouterProvider(record(), deps()).getSigner();
    const err = (await signer
      .signTransaction({ to: '0x1111111111111111111111111111111111111111' })
      .catch((cause) => cause)) as CliError;

    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('raw transaction');
  });

  it.skipIf(process.platform === 'win32')(
    'warns when ClawRouter key permissions are broad',
    async () => {
      await writeKey();
      await chmod(keyPath, 0o644);
      const diagnostics = await createClawRouterProvider(record(), deps()).diagnostics();
      expect(diagnostics.warnings.join('\n')).toContain('expected 600');
      expect((await stat(keyPath)).mode & 0o777).toBe(0o644);
    },
  );
});
