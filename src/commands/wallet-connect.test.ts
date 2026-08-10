import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { runWalletConnect, runWalletCreate, runWalletShow } from './wallet';
import { readWalletRecord } from '../lib/wallet/store';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

// Real ox scrypt at N=262144 exceeds Vitest's 5s default under full-suite
// parallel load. Match the other wallet suites rather than weakening the
// global timeout for tests that should fail fast.
vi.setConfig({ testTimeout: 120000 });

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

describe('runWalletConnect clawrouter', () => {
  it('connects an existing signer without copying its key or mnemonic', async () => {
    const sourceBefore = await sourceSnapshot();
    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    const record = await readWalletRecord(dataDir);
    const raw = await readFile(join(dataDir, 'wallet.json'), 'utf8');

    expect(result.data).toMatchObject({
      address: privateKeyToAccount(key).address,
      provider: 'clawrouter',
      credentialSource: 'file',
      connected: true,
      custody: {
        sourceOwnedBy: 'clawrouter-user',
        sourceMutationByTenjin: 'none',
        sourceDeletedByTenjin: false,
        connectMovesFunds: false,
        privateKeyAccess: 'read-into-process-memory-at-connect-and-sign',
        privateKeyCopiedToTenjinStorage: false,
        privateKeyPersistedByTenjin: false,
        privateKeyLogged: false,
        privateKeyReturned: false,
        privateKeyTransmitted: false,
        mnemonicAccessed: false,
        rawTransactionSigning: false,
        pinnedAddressDriftRefusal: true,
        humanAcknowledgement: 'not-proven',
        sameUserUnrestrictedAgentContained: false,
        enforcementBoundary: 'outside-tenjin-process',
      },
    });
    expect(record).toMatchObject({ schemaVersion: 3, provider: 'clawrouter' });
    expect(raw).not.toContain(key);
    expect(raw).not.toContain('mnemonic');
    expect((await stat(join(dataDir, 'wallet.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.humanLines?.join('\n')).toMatch(/reads the private key into this process/i);
    expect(result.humanLines?.join('\n')).toMatch(/externally owned and read-only to Tenjin/i);
    expect(result.humanLines?.join('\n')).toMatch(/human acknowledgment is not proven/i);
    expect(await sourceSnapshot()).toEqual(sourceBefore);
  });

  it('is idempotent when the same address is already connected', async () => {
    await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    const sourceBefore = await sourceSnapshot();
    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    expect(result.data).toMatchObject({ connected: false });
    expect(await sourceSnapshot()).toEqual(sourceBefore);
  });

  it('--replace changes only Tenjin metadata when ClawRouter rotates its signer', async () => {
    const oldAddress = privateKeyToAccount(key).address;
    await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    key = generatePrivateKey();
    await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
    const sourceBefore = await sourceSnapshot();

    const result = await runWalletConnect({ provider: 'clawrouter' }, ctx(), {
      ...connectOpts(),
      replace: true,
    });

    expect(result.data).toMatchObject({
      address: privateKeyToAccount(key).address,
      provider: 'clawrouter',
      replaced: { address: oldAddress },
    });
    expect(await sourceSnapshot()).toEqual(sourceBefore);
    await expect(
      readFile(join(dataDir, `wallet.${oldAddress.toLowerCase()}.json.bak`), 'utf8'),
    ).resolves.not.toContain(key);
  });

  it('refuses local --replace without touching the ClawRouter source or pointer', async () => {
    await runWalletConnect({ provider: 'clawrouter' }, ctx(), connectOpts());
    const sourceBefore = await sourceSnapshot();
    const pointerBefore = await readFile(join(dataDir, 'wallet.json'), 'utf8');

    const err = (await runWalletCreate(ctx(), { replace: true }).catch(
      (cause) => cause,
    )) as CliError;

    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('managed by ClawRouter');
    expect(await sourceSnapshot()).toEqual(sourceBefore);
    expect(await readFile(join(dataDir, 'wallet.json'), 'utf8')).toBe(pointerBefore);
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
