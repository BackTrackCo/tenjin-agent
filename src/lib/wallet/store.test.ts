import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../errors';
import { readWalletRecord, walletFileExists, walletFileMode, writeWalletRecord } from './store';
import { fakeRecord } from './test-support';

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

const walletFile = () => join(dataDir, 'wallet.json');

describe('writeWalletRecord', () => {
  it.skipIf(isWindows)('writes 0600 in a 0700 dir', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    expect((await stat(walletFile())).mode & 0o777).toBe(0o600);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });

  it('round-trips through readWalletRecord', async () => {
    const record = fakeRecord();
    await writeWalletRecord(dataDir, record);
    expect(await readWalletRecord(dataDir)).toEqual(record);
  });

  it('never writes the raw private key: no 0x-prefixed 64-hex appears in the file', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    const raw = await readFile(walletFile(), 'utf8');
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

describe('readWalletRecord', () => {
  it('returns null when the file is absent', async () => {
    expect(await readWalletRecord(dataDir)).toBeNull();
  });

  it('throws WALLET_INVALID_KEY on malformed JSON', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    await writeFile(walletFile(), '{ not json');
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.fix).toContain(walletFile());
  });

  it('throws WALLET_INVALID_KEY when the record fails the schema', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    await writeFile(walletFile(), JSON.stringify({ schemaVersion: 2, provider: 'local' }));
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('rejects a malformed keystore in the record', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    await writeFile(
      walletFile(),
      JSON.stringify({
        schemaVersion: 2,
        provider: 'local',
        address: '0x' + 'a'.repeat(40),
        keystore: { version: 3, id: 'x', crypto: { cipher: 'nope' } },
        createdAt: new Date().toISOString(),
      }),
    );
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('rejects a pre-encryption v1 plaintext record with the recreate fix', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    await writeFile(
      walletFile(),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'local',
        address: '0x' + 'a'.repeat(40),
        privateKey: `0x${'de'.repeat(32)}`,
        createdAt: new Date().toISOString(),
      }),
    );
    const err = (await readWalletRecord(dataDir).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain('predates encrypted storage');
    expect(err.fix).toContain('sweep any funds');
  });
});

describe('walletFileExists / walletFileMode', () => {
  it('report absence before creation', async () => {
    expect(await walletFileExists(dataDir)).toBe(false);
    expect(await walletFileMode(dataDir)).toBeNull();
  });

  it('report presence after creation', async () => {
    await writeWalletRecord(dataDir, fakeRecord());
    expect(await walletFileExists(dataDir)).toBe(true);
    expect(await walletFileMode(dataDir)).not.toBeNull();
  });
});
