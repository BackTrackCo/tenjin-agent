import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { runWalletConnect, runWalletCreate, runWalletShow } from './wallet';
import { readWalletRecord } from '../lib/wallet/store';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

const PASSPHRASE = 'connect-test-passphrase';
let dir: string;
let dataDir: string;
let keyPath: string;
let key: `0x${string}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-wallet-connect-'));
  dataDir = join(dir, '.tenjin');
  keyPath = join(dir, '.openclaw', 'blockrun', 'wallet.key');
  key = generatePrivateKey();
  vi.stubEnv('TENJIN_WALLET_PASSPHRASE', PASSPHRASE);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    dataDir,
    flags: { json: true, timeout: 1000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

const connectOpts = () => ({ clawrouter: { walletKeyPath: keyPath, env: {} } });

describe('runWalletConnect clawrouter', () => {
  it('connects an existing signer without copying its key or mnemonic', async () => {
    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    const record = await readWalletRecord(dataDir);
    const raw = await readFile(join(dataDir, 'wallet.json'), 'utf8');

    expect(result.data).toMatchObject({
      address: privateKeyToAccount(key).address,
      provider: 'clawrouter',
      credentialSource: 'file',
      connected: true,
    });
    expect(record).toMatchObject({ schemaVersion: 3, provider: 'clawrouter' });
    expect(raw).not.toContain(key);
    expect(raw).not.toContain('mnemonic');
    expect((await stat(join(dataDir, 'wallet.json'))).mode & 0o777).toBe(0o600);
  });

  it('is idempotent when the same address is already connected', async () => {
    await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    expect(result.data).toMatchObject({ connected: false });
  });

  it('refuses to displace a local wallet without --replace', async () => {
    await runWalletCreate(ctx());
    const err = (await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts()).catch(
      (cause) => cause,
    )) as CliError;
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.fix).toContain('--replace');
    expect((await readWalletRecord(dataDir))?.provider).toBe('local');
  });

  it('--replace preserves and archives the local wallet before switching', async () => {
    const local = await runWalletCreate(ctx());
    const localAddress = (local.data as { address: string }).address;
    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), {
      ...connectOpts(),
      replace: true,
    });
    const archived = join(dataDir, `wallet.${localAddress.toLowerCase()}.json.bak`);

    expect(result.data).toMatchObject({
      provider: 'clawrouter',
      replaced: {
        address: localAddress,
        archivedWalletPath: archived,
        passphrasePreserved: 'env',
      },
    });
    expect((await readWalletRecord(dataDir))?.provider).toBe('clawrouter');
    await expect(readFile(archived, 'utf8')).resolves.toContain('"keystore"');
  });

  it('routes show through the connected provider without exposing the key', async () => {
    await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    // Production resolution uses the canonical HOME path. Inject the provider
    // seams through the command for this isolated test directory.
    const shown = await runWalletShow(ctx(), { clawrouter: connectOpts().clawrouter });
    expect(shown.data).toMatchObject({
      address: privateKeyToAccount(key).address,
      provider: 'clawrouter',
      credentialSource: 'file',
    });
    expect(JSON.stringify(shown)).not.toContain(key);
  });

  it('refuses an unknown provider without touching the active record', async () => {
    const err = (await runWalletConnect({ provider: 'blockrun-mcp' }, ctx()).catch(
      (cause) => cause,
    )) as CliError;
    expect(err.code).toBe('USAGE');
    expect(await readWalletRecord(dataDir)).toBeNull();
  });
});
