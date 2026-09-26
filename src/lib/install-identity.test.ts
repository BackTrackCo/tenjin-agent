import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enableCliIdentity,
  enableDaemonIdentity,
  identityFor,
  readOrCreateInstallId,
  readWalletAddress,
  tenjinOrigins,
} from './install-identity';
import {
  httpRequest,
  INSTALL_HEADER,
  setTenjinIdentity,
  tenjinIdentityHeaders,
  WALLET_HEADER,
} from './http';
import { installIdPath, walletPath } from './paths';
import { PRODUCTION_ORIGIN, knownDeploymentOrigins } from './production-origin';

const ADDRESS = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A record that passes the store's structural check. Never decrypted, so the
 *  keystore is shape only and no passphrase or keychain is involved. */
function walletRecord(): string {
  return JSON.stringify({
    schemaVersion: 2,
    provider: 'local',
    address: ADDRESS,
    keystore: {
      crypto: {
        cipher: 'aes-128-ctr',
        ciphertext: '00',
        cipherparams: { iv: '00' },
        kdf: 'scrypt',
        kdfparams: {},
        mac: '00',
      },
      id: 'test',
      version: 3,
    },
    createdAt: '2026-09-25T00:00:00.000Z',
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-identity-'));
});

afterEach(async () => {
  setTenjinIdentity(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('readOrCreateInstallId', () => {
  it('mints a UUID once and returns the same one on every later read', async () => {
    const first = await readOrCreateInstallId(dir);
    expect(first).toMatch(UUID_RE);
    expect((await readFile(installIdPath(dir), 'utf8')).trim()).toBe(first);
    expect(await readOrCreateInstallId(dir)).toBe(first);
  });

  it('agrees on one id when two first runs race', async () => {
    const ids = await Promise.all([readOrCreateInstallId(dir), readOrCreateInstallId(dir)]);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toBe(ids[0]);
  });

  it('sends nothing for a corrupt file, and leaves it alone', async () => {
    await writeFile(installIdPath(dir), 'not-a-uuid\n');
    expect(await readOrCreateInstallId(dir)).toBeUndefined();
    expect(await readFile(installIdPath(dir), 'utf8')).toBe('not-a-uuid\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'sends nothing for an unreadable file',
    async () => {
      await writeFile(installIdPath(dir), `${crypto.randomUUID()}\n`);
      await chmod(installIdPath(dir), 0o000);
      expect(await readOrCreateInstallId(dir)).toBeUndefined();
    },
  );

  it('sends nothing when the data dir cannot be created', async () => {
    const blocked = join(dir, 'file');
    await writeFile(blocked, '');
    expect(await readOrCreateInstallId(join(blocked, 'data'))).toBeUndefined();
  });
});

describe('readWalletAddress', () => {
  it('reads the cleartext address without a passphrase', async () => {
    await writeFile(walletPath(dir), walletRecord());
    expect(await readWalletAddress(dir)).toBe(ADDRESS);
  });

  it('is absent with no wallet file, and for a corrupt one', async () => {
    expect(await readWalletAddress(dir)).toBeUndefined();
    await writeFile(walletPath(dir), '{not json');
    expect(await readWalletAddress(dir)).toBeUndefined();
  });
});

describe('tenjinOrigins', () => {
  it('is Tenjin, the public shelf and the base URL this run points at', () => {
    expect(
      tenjinOrigins({
        baseUrl: 'http://localhost:3000/',
        publicShelfUrl: PRODUCTION_ORIGIN,
        teamMode: false,
      }).sort(),
    ).toEqual([...knownDeploymentOrigins(), 'http://localhost:3000'].sort());
  });

  it("leaves a team shelf out: that deployment is the team's, not Tenjin's", () => {
    const origins = tenjinOrigins({
      baseUrl: 'https://team.example',
      publicShelfUrl: PRODUCTION_ORIGIN,
      teamMode: true,
    });
    expect(origins).not.toContain('https://team.example');
    expect(origins).toContain(PRODUCTION_ORIGIN);
  });
});

describe('identityFor', () => {
  const tenjin = async (): Promise<readonly string[]> => [PRODUCTION_ORIGIN];

  it('keeps the install id stable across two processes on one data dir', async () => {
    await writeFile(walletPath(dir), walletRecord());
    // Two identities share nothing but the data dir, as two processes would.
    const a = await identityFor(dir, tenjin).values();
    const b = await identityFor(dir, tenjin).values();
    expect(a.install).toMatch(UUID_RE);
    expect(b).toEqual(a);
    expect(a.wallet).toBe(ADDRESS);
  });

  it('picks up a wallet created after the first request', async () => {
    const identity = identityFor(dir, tenjin);
    expect((await identity.values()).wallet).toBeUndefined();
    await writeFile(walletPath(dir), walletRecord());
    expect((await identity.values()).wallet).toBe(ADDRESS);
  });
});

describe('enableCliIdentity', () => {
  function recorder(): { fetchImpl: typeof fetch; seen: Array<Record<string, string>> } {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response('{}', { status: 200 });
    };
    return { fetchImpl, seen };
  }

  it('attaches both headers to the configured base URL and none to a provider', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:4321' }));
    await writeFile(walletPath(dir), walletRecord());
    enableCliIdentity(dir, {});
    const { fetchImpl, seen } = recorder();
    await httpRequest('http://127.0.0.1:4321/api/x402-router', {
      method: 'POST',
      timeoutMs: 1000,
      jsonBody: {},
      fetchImpl,
    });
    await httpRequest('https://api.exa.ai/search', { timeoutMs: 1000, fetchImpl });
    expect(seen[0]?.[INSTALL_HEADER]).toMatch(UUID_RE);
    expect(seen[0]?.[WALLET_HEADER]).toBe(ADDRESS);
    expect(seen[1]).not.toHaveProperty(INSTALL_HEADER);
    expect(seen[1]).not.toHaveProperty(WALLET_HEADER);
  });

  it('honours TENJIN_BASE_URL, and sends nothing when config.json is corrupt', async () => {
    enableCliIdentity(dir, { TENJIN_BASE_URL: 'http://127.0.0.1:9999' });
    expect(await tenjinIdentityHeaders('http://127.0.0.1:9999/api/search')).toHaveProperty(
      INSTALL_HEADER,
    );

    await writeFile(join(dir, 'config.json'), '{corrupt');
    enableCliIdentity(dir, {});
    expect(await tenjinIdentityHeaders(`${PRODUCTION_ORIGIN}/api/search`)).toEqual({});
  });
});

describe('enableDaemonIdentity', () => {
  it("follows the daemon's live config, and leaves out a team shelf", async () => {
    let config = {
      baseUrl: 'https://team.example',
      publicShelfUrl: PRODUCTION_ORIGIN,
      shelfBypassSecret: 'door-key',
    };
    enableDaemonIdentity(dir, () => config);
    expect(await tenjinIdentityHeaders('https://team.example/api/search')).toEqual({});
    expect(await tenjinIdentityHeaders(`${PRODUCTION_ORIGIN}/api/search`)).toHaveProperty(
      INSTALL_HEADER,
    );

    config = { ...config, shelfBypassSecret: '' };
    expect(await tenjinIdentityHeaders('https://team.example/api/search')).toHaveProperty(
      INSTALL_HEADER,
    );
  });
});
