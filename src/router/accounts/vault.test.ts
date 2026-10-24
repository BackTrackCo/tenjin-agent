import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceKeyFilePath, sourceVaultPath, sourcesDir } from '../../lib/paths';
import { CliError } from '../../lib/errors';
import { connectedSourceIds } from './presence';
import { fakeKeychain } from './test-support';
import {
  clearVaultKeyCache,
  deleteVault,
  readVault,
  readVaultHeader,
  rewriteVault,
  writeVault,
  type HeaderInput,
} from './vault';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-vault-'));
  clearVaultKeyCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HEADER: HeaderInput = {
  kind: 'oauth',
  mcpUrl: 'https://mcp.apify.com',
  connectedAt: '2026-10-23T10:00:00.000Z',
  expiresAt: '2026-10-23T11:00:00.000Z',
  state: 'ok',
  ready: ['apify.google-maps-places'],
  missing: [],
};

const SECRET = {
  tokens: {
    access_token: 'at-123',
    refresh_token: 'rt-456',
    token_type: 'Bearer',
    issuer: 'https://as.example',
  },
  obtainedAt: 1_000,
  clientInformation: { client_id: 'https://tenjin.sh/oauth/client-metadata.json' },
};

describe('the vault of a connected account', () => {
  it('seals the sign-in under a key kept in the keychain, and reads it back', async () => {
    const keychain = fakeKeychain();
    const deps = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    const { header, plainFile } = await writeVault('apify', 'Apify', HEADER, SECRET, deps);
    expect(plainFile).toBe(false);
    expect(header).toMatchObject({ version: 1, id: 'apify', store: 'keychain', state: 'ok' });
    // The key is the one secret in the keychain: 43 base64url characters
    // under service tenjin-cli, account source:apify.
    expect([...keychain.entries.keys()]).toEqual(['tenjin-cli/source:apify']);
    expect(keychain.entries.get('tenjin-cli/source:apify')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The file holds no token in the clear, at 0600 in a 0700 folder.
    const raw = await readFile(sourceVaultPath('apify', dir), 'utf8');
    expect(raw).not.toContain('at-123');
    expect(raw).not.toContain('rt-456');
    if (process.platform !== 'win32') {
      expect((await stat(sourceVaultPath('apify', dir))).mode & 0o777).toBe(0o600);
      expect((await stat(sourcesDir(dir))).mode & 0o777).toBe(0o700);
    }
    // A fresh process reads the key from the keychain, not a cache.
    clearVaultKeyCache();
    const read = await readVault('apify', 'Apify', deps);
    expect(read).toEqual({ status: 'ok', header, secret: SECRET });
  });

  it('reads the header with no key and no keychain call', async () => {
    const keychain = fakeKeychain();
    await writeVault('apify', 'Apify', HEADER, SECRET, {
      dataDir: dir,
      platform: 'darwin',
      exec: keychain.exec,
    });
    const before = keychain.calls.length;
    expect(await readVaultHeader(dir, 'apify')).toMatchObject({
      kind: 'oauth',
      ready: HEADER.ready,
    });
    expect(keychain.calls).toHaveLength(before);
    expect(await readVaultHeader(dir, 'fal')).toBeNull();
    expect(await readVaultHeader(dir, '../wallet')).toBeNull();
  });

  it('binds the header: a hand-edited one no longer opens', async () => {
    const keychain = fakeKeychain();
    const deps = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    await writeVault('apify', 'Apify', HEADER, SECRET, deps);
    const path = sourceVaultPath('apify', dir);
    const file = JSON.parse(await readFile(path, 'utf8')) as { header: { ready: string[] } };
    file.header.ready = ['apify.something-else'];
    await writeFile(path, JSON.stringify(file));
    clearVaultKeyCache();
    expect((await readVault('apify', 'Apify', deps)).status).toBe('unreadable');
  });

  it('keeps the key across a reconnect and a rewrite, and writes the keychain once', async () => {
    const keychain = fakeKeychain();
    const deps = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    await writeVault('apify', 'Apify', HEADER, SECRET, deps);
    const key = keychain.entries.get('tenjin-cli/source:apify');
    clearVaultKeyCache();
    const { header } = await writeVault(
      'apify',
      'Apify',
      HEADER,
      { apiKey: 'k', keyScheme: 'Bearer' },
      deps,
    );
    await rewriteVault('apify', 'Apify', { ...header, state: 'expired' }, { apiKey: 'k2' }, deps);
    expect(keychain.entries.get('tenjin-cli/source:apify')).toBe(key);
    expect(keychain.calls.filter(({ args }) => args[0] === '-i')).toHaveLength(1);
    clearVaultKeyCache();
    const read = await readVault('apify', 'Apify', deps);
    expect(read).toMatchObject({
      status: 'ok',
      header: { state: 'expired' },
      secret: { apiKey: 'k2' },
    });
  });

  it('refuses, and writes nothing, when the keychain does not answer', async () => {
    const keychain = fakeKeychain({ locked: true });
    const error = await writeVault('apify', 'Apify', HEADER, SECRET, {
      dataDir: dir,
      platform: 'darwin',
      exec: keychain.exec,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Tenjin couldn't keep the sign-in for Apify: your macOS keychain didn't answer. Nothing was saved.",
    );
    // The account's lock leaves its private folder behind, and nothing in it.
    expect(await readdir(sourcesDir(dir))).toEqual([]);
  });

  it('keeps the key in a 0600 file, and says so, where no OS store exists', async () => {
    const deps = {
      dataDir: dir,
      platform: 'aix' as NodeJS.Platform,
      exec: async () => {
        throw new Error('no store command may run');
      },
    };
    const { header, plainFile } = await writeVault('fal', 'fal', HEADER, SECRET, deps);
    expect(plainFile).toBe(true);
    expect(header.store).toBe('file');
    const keyFile = sourceKeyFilePath('fal', dir);
    expect(keyFile).toBe(join(dir, 'sources', 'fal.key.plain'));
    expect(await readFile(keyFile, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    clearVaultKeyCache();
    expect((await readVault('fal', 'fal', deps)).status).toBe('ok');
  });

  it('names its files after the account alone, never a passphrase path', async () => {
    const keychain = fakeKeychain();
    await writeVault('apify', 'Apify', HEADER, SECRET, {
      dataDir: dir,
      platform: 'darwin',
      exec: keychain.exec,
    });
    const names = await readdir(sourcesDir(dir));
    expect(names).toEqual(['apify.json']);
    for (const name of names) expect(name).not.toMatch(/passphrase|:/);
  });

  it('deletes the vault and its key, and is connected only with both a vault and a descriptor', async () => {
    const keychain = fakeKeychain();
    const deps = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    await writeVault('apify', 'Apify', HEADER, SECRET, deps);
    expect(connectedSourceIds(dir, ['apify', 'fal', 'tenjin', 'Bad Id'])).toEqual(['apify']);
    expect(await deleteVault('apify', deps)).toEqual({ removed: true });
    expect(keychain.entries.size).toBe(0);
    expect(connectedSourceIds(dir, ['apify'])).toEqual([]);
    expect(await deleteVault('apify', deps)).toEqual({ removed: false });
    expect((await readVault('apify', 'Apify', deps)).status).toBe('absent');
  });
});
