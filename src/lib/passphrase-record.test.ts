import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors';
import {
  PASSPHRASE_RECORD_SCHEMA_VERSION,
  readPassphraseRecord,
  writePassphraseRecord,
} from './passphrase-record';
import { passphraseRecordPath } from './paths';

const isWindows = process.platform === 'win32';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const NOW = new Date('2026-10-22T12:00:00.000Z');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-pr-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRaw(value: unknown): Promise<void> {
  await writeFile(
    passphraseRecordPath(dir),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('passphrase-record', () => {
  it('round-trips an entry', async () => {
    await writePassphraseRecord(dir, A, { store: 'keychain', by: 'create' }, NOW);
    expect(await readPassphraseRecord(dir, A)).toEqual({
      store: 'keychain',
      recordedAt: NOW.toISOString(),
      by: 'create',
    });
    const raw = JSON.parse(await readFile(passphraseRecordPath(dir), 'utf8'));
    expect(raw.schemaVersion).toBe(PASSPHRASE_RECORD_SCHEMA_VERSION);
  });

  it.skipIf(isWindows)('writes the file at 0600 in a 0700 directory', async () => {
    const nested = join(dir, 'data');
    await writePassphraseRecord(nested, A, { store: 'file', by: 'repair' }, NOW);
    expect((await stat(passphraseRecordPath(nested))).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it('reads null for an absent file', async () => {
    expect(await readPassphraseRecord(dir, A)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['corrupt JSON', '{not json'],
    [
      'schemaVersion 2',
      { schemaVersion: 2, wallets: { [A]: { store: 'keychain', recordedAt: 'x', by: 'create' } } },
    ],
    [
      'an unknown store value',
      { schemaVersion: 1, wallets: { [A]: { store: 'cloud', recordedAt: 'x', by: 'create' } } },
    ],
    [
      'no entry for the address',
      { schemaVersion: 1, wallets: { [B]: { store: 'file', recordedAt: 'x', by: 'create' } } },
    ],
  ])('reads null for %s', async (_label, value) => {
    await writeRaw(value);
    expect(await readPassphraseRecord(dir, A)).toBeNull();
  });

  it('writing B keeps A', async () => {
    await writePassphraseRecord(dir, A, { store: 'keychain', by: 'create' }, NOW);
    await writePassphraseRecord(dir, B, { store: 'file', by: 'repair' }, NOW);
    expect((await readPassphraseRecord(dir, A))?.store).toBe('keychain');
    expect((await readPassphraseRecord(dir, B))?.store).toBe('file');
  });

  it('keeps an entry this build cannot read when writing another', async () => {
    const future = { store: 'tpm', recordedAt: 'x', by: 'create' };
    await writeRaw({ schemaVersion: 1, wallets: { [B]: future } });
    await writePassphraseRecord(dir, A, { store: 'dpapi', by: 'replace' }, NOW);
    const raw = JSON.parse(await readFile(passphraseRecordPath(dir), 'utf8'));
    expect(raw.wallets[B]).toEqual(future);
    expect(raw.wallets[A].store).toBe('dpapi');
  });

  it('replaces a sidecar that does not parse with only the new entry', async () => {
    await writeRaw('garbage');
    await writePassphraseRecord(dir, A, { store: 'file', by: 'create' }, NOW);
    const raw = JSON.parse(await readFile(passphraseRecordPath(dir), 'utf8'));
    expect(Object.keys(raw.wallets)).toEqual([A]);
  });

  it('stores a mixed-case address lowercase and finds it in any case', async () => {
    const mixed = '0x' + 'AbCdEf0123'.repeat(4);
    await writePassphraseRecord(dir, mixed, { store: 'secret-service', by: 'create' }, NOW);
    const raw = JSON.parse(await readFile(passphraseRecordPath(dir), 'utf8'));
    expect(Object.keys(raw.wallets)).toEqual([mixed.toLowerCase()]);
    expect((await readPassphraseRecord(dir, mixed.toUpperCase().replace('0X', '0x')))?.store).toBe(
      'secret-service',
    );
  });

  it('refuses a value that is not an address', async () => {
    await expect(
      writePassphraseRecord(dir, '0x123', { store: 'file', by: 'create' }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(
      writePassphraseRecord(dir, '../etc', { store: 'file', by: 'create' }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
