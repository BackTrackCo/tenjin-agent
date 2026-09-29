import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enableCliIdentity,
  enableDaemonIdentity,
  identityFor,
  readOrCreateInstallId,
  tenjinOrigins,
} from './install-identity';
import { httpRequest, INSTALL_ID_HEADER, setTenjinIdentity, tenjinIdentityHeaders } from './http';
import { installIdPath } from './paths';
import { PRODUCTION_ORIGIN, knownDeploymentOrigins } from './production-origin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

describe('tenjinOrigins', () => {
  it("is Tenjin's deployments and the base URL this run points at", () => {
    expect(tenjinOrigins({ baseUrl: 'http://localhost:3000/', teamMode: false }).sort()).toEqual(
      [...knownDeploymentOrigins(), 'http://localhost:3000'].sort(),
    );
  });

  it("leaves a team shelf out: that deployment is the team's, not Tenjin's", () => {
    const origins = tenjinOrigins({
      baseUrl: 'https://team.example',
      teamMode: true,
    });
    expect(origins).not.toContain('https://team.example');
    expect(origins).toContain(PRODUCTION_ORIGIN);
  });
});

describe('identityFor', () => {
  const tenjin = async (): Promise<readonly string[]> => [PRODUCTION_ORIGIN];

  it('keeps the install id stable across two processes on one data dir', async () => {
    // Two identities share nothing but the data dir, as two processes would.
    const a = await identityFor(dir, tenjin).installId();
    const b = await identityFor(dir, tenjin).installId();
    expect(a).toMatch(UUID_RE);
    expect(b).toBe(a);
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

  it('attaches the id to the configured base URL and not to a provider', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:4321' }));
    enableCliIdentity(dir, {});
    const { fetchImpl, seen } = recorder();
    await httpRequest('http://127.0.0.1:4321/api/x402-router', {
      method: 'POST',
      timeoutMs: 1000,
      jsonBody: {},
      fetchImpl,
    });
    await httpRequest('https://api.exa.ai/search', { timeoutMs: 1000, fetchImpl });
    expect(seen[0]?.[INSTALL_ID_HEADER]).toMatch(UUID_RE);
    expect(seen[1]).not.toHaveProperty(INSTALL_ID_HEADER);
  });

  it('does not send the id to a custom public shelf', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ publicShelfUrl: 'https://shelf.example' }),
    );
    enableCliIdentity(dir, {});
    expect(await tenjinIdentityHeaders('https://shelf.example/api/search')).toEqual({});
    expect(await tenjinIdentityHeaders(`${PRODUCTION_ORIGIN}/api/search`)).toHaveProperty(
      INSTALL_ID_HEADER,
    );
  });

  it('honours TENJIN_BASE_URL, and sends nothing when config.json is corrupt', async () => {
    enableCliIdentity(dir, { TENJIN_BASE_URL: 'http://127.0.0.1:9999' });
    expect(await tenjinIdentityHeaders('http://127.0.0.1:9999/api/search')).toHaveProperty(
      INSTALL_ID_HEADER,
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
      INSTALL_ID_HEADER,
    );

    config = { ...config, shelfBypassSecret: '' };
    expect(await tenjinIdentityHeaders('https://team.example/api/search')).toHaveProperty(
      INSTALL_ID_HEADER,
    );
  });
});
