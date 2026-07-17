import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CliError } from '../errors';
import {
  readWalletRecord,
  walletFileExists,
  walletFileMode,
  writeWalletRecord,
  type WalletRecord,
} from './store';

const isWindows = process.platform === 'win32';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-store-'));
  dataDir = join(tmp, '.tenjin');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function freshRecord(): WalletRecord {
  const privateKey = generatePrivateKey();
  return {
    schemaVersion: 1,
    provider: 'local',
    address: privateKeyToAccount(privateKey).address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
}

const walletFile = () => join(dataDir, 'wallet.json');

describe('writeWalletRecord', () => {
  it.skipIf(isWindows)('writes 0600 in a 0700 dir', async () => {
    await writeWalletRecord(dataDir, freshRecord());
    expect((await stat(walletFile())).mode & 0o777).toBe(0o600);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });

  it('round-trips through readWalletRecord', async () => {
    const record = freshRecord();
    await writeWalletRecord(dataDir, record);
    expect(await readWalletRecord(dataDir)).toEqual(record);
  });
});

describe('readWalletRecord', () => {
  it('returns null when the file is absent', async () => {
    expect(await readWalletRecord(dataDir)).toBeNull();
  });

  it('throws WALLET_INVALID_KEY on malformed JSON', async () => {
    await writeWalletRecord(dataDir, freshRecord());
    await writeFile(walletFile(), '{ not json');
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.fix).toContain(walletFile());
  });

  it('throws WALLET_INVALID_KEY when the record fails the schema', async () => {
    await writeWalletRecord(dataDir, freshRecord());
    await writeFile(walletFile(), JSON.stringify({ schemaVersion: 1, provider: 'local' }));
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('rejects a bad private key format in the record', async () => {
    await writeWalletRecord(dataDir, freshRecord());
    await writeFile(
      walletFile(),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'local',
        address: '0x' + 'a'.repeat(40),
        privateKey: '0xdeadbeef',
        createdAt: new Date().toISOString(),
      }),
    );
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });
});

describe('walletFileExists / walletFileMode', () => {
  it('report absence before creation', async () => {
    expect(await walletFileExists(dataDir)).toBe(false);
    expect(await walletFileMode(dataDir)).toBeNull();
  });

  it('report presence after creation', async () => {
    await writeWalletRecord(dataDir, freshRecord());
    expect(await walletFileExists(dataDir)).toBe(true);
    expect(await walletFileMode(dataDir)).not.toBeNull();
  });
});
