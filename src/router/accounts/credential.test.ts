import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../../lib/lock';
import { sourceVaultPath } from '../../lib/paths';
import { AccountRefusal, accountCredential, type CredentialDeps } from './credential';
import { fakeAccountServer, fakeKeychain } from './test-support';
import {
  clearVaultKeyCache,
  readVault,
  readVaultHeader,
  rewriteVault,
  writeVault,
  type VaultSecret,
} from './vault';

/**
 * A CONNECTED ACCOUNT'S CREDENTIAL, kept fresh: a refresh under the lock beside
 * the vault, one per process and one across processes, bounded, and a refused
 * grant that ends every later call at once. The token endpoint is the scripted
 * account server behind the injected fetch; the keychain is a fake.
 */

const ISSUER = 'https://auth.example.test';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-credential-'));
  clearVaultKeyCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SIGNED_IN: VaultSecret = {
  tokens: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    token_type: 'Bearer',
    issuer: ISSUER,
  },
  obtainedAt: NOW - 3_600_000,
  clientInformation: { client_id: 'https://tenjin.sh/oauth/client-metadata.json' },
  discoveryState: {
    authorizationServerUrl: ISSUER,
    authorizationServerMetadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ['code'],
    },
    resourceMetadata: { resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth' },
  },
};

async function connected(
  expiresAt: string,
  over: { secret?: VaultSecret; kind?: 'oauth' | 'key' } = {},
) {
  const keychain = fakeKeychain();
  const vault = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
  await writeVault(
    'firecrawl',
    'Firecrawl',
    {
      kind: over.kind ?? 'oauth',
      mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
      connectedAt: new Date(NOW - 3_600_000).toISOString(),
      ...(over.kind === 'key' ? {} : { expiresAt }),
      state: 'ok',
      ready: ['firecrawl.scrape'],
      missing: [],
    },
    over.secret ?? SIGNED_IN,
    vault,
  );
  return vault;
}

function deps(
  vault: { dataDir: string; platform: 'darwin'; exec: CredentialDeps['exec'] },
  server: ReturnType<typeof fakeAccountServer>,
  over: Partial<CredentialDeps> = {},
): CredentialDeps {
  return { ...vault, fetchImpl: server.fetchImpl, now: () => NOW, ...over };
}

const server = (
  over: Parameters<typeof fakeAccountServer>[0] extends infer T ? Partial<T> : never,
) =>
  fakeAccountServer({ mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth', issuer: ISSUER, ...over });

const refusal = (err: unknown) => (err instanceof AccountRefusal ? err.reason : String(err));

describe("a connected account's credential", () => {
  it('sends a fresh token as it is, with no request', async () => {
    const vault = await connected('2026-10-23T13:00:00.000Z');
    const account = server({});
    const credential = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account));
    expect(credential.headers).toEqual({ authorization: 'Bearer access-1' });
    expect(account.seen).toEqual([]);
  });

  it('refreshes a token about to expire, and keeps the new one and its issuer', async () => {
    const vault = await connected('2026-10-23T12:00:30.000Z');
    const account = server({});
    const credential = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account));
    expect(credential.headers).toEqual({ authorization: 'Bearer access-2' });
    expect(account.refreshes).toEqual(['refresh-1']);
    const token = account.seen.find(({ url }) => url === `${ISSUER}/token`);
    expect(new URLSearchParams(token?.body).get('resource')).toBe(
      'https://mcp.firecrawl.dev/v2/mcp-oauth',
    );
    clearVaultKeyCache();
    const kept = await readVault('firecrawl', 'Firecrawl', vault);
    expect(kept.status).toBe('ok');
    if (kept.status !== 'ok') return;
    expect(kept.header).toMatchObject({ state: 'ok', expiresAt: '2026-10-23T13:00:00.000Z' });
    expect(kept.secret.tokens).toMatchObject({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      issuer: ISSUER,
    });
    expect(kept.secret.obtainedAt).toBe(NOW);
  });

  it('refreshes a token the account just refused, however long it has left', async () => {
    const vault = await connected('2026-10-23T13:00:00.000Z');
    const account = server({});
    const credential = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account), {
      refused: 'access-1',
    });
    expect(credential.sent).toBe('access-2');
    expect(account.refreshes).toEqual(['refresh-1']);
  });

  it('refreshes once for parallel calls: each later one finds the rotated token', async () => {
    const vault = await connected('2026-10-23T12:00:10.000Z');
    const account = server({});
    const got = await Promise.all(
      [1, 2, 3].map(() => accountCredential('firecrawl', 'Firecrawl', deps(vault, account))),
    );
    expect(got.map(({ sent }) => sent)).toEqual(['access-2', 'access-2', 'access-2']);
    expect(account.refreshes).toEqual(['refresh-1']);
  });

  it("waits on another process's refresh and uses the token it left, never refreshing twice", async () => {
    const vault = await connected('2026-10-23T12:00:10.000Z');
    const account = server({});
    const lock = `${sourceVaultPath('firecrawl', dir)}.lock`;
    let settled = false;
    const waiting = await withFileLock(lock, async () => {
      // Another process holds the lock, mid-refresh: this call reads the old
      // token, sees it expiring, and waits.
      const call = accountCredential('firecrawl', 'Firecrawl', deps(vault, account)).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      // The other process rotates the single-use refresh token and lets go.
      const header = (await readVaultHeader(dir, 'firecrawl'))!;
      await rewriteVault(
        'firecrawl',
        'Firecrawl',
        { ...header, expiresAt: '2026-10-23T13:00:00.000Z' },
        {
          ...SIGNED_IN,
          tokens: { ...SIGNED_IN.tokens, access_token: 'rotated', refresh_token: 'refresh-r' },
        },
        vault,
      );
      // Handed out unawaited: it can only finish once this lock is let go.
      return { call };
    });
    expect((await waiting.call).headers).toEqual({ authorization: 'Bearer rotated' });
    expect(account.refreshes).toEqual([]);
  });

  it('stops waiting at its bound, names the lock, and sends nothing', async () => {
    const vault = await connected('2026-10-23T12:00:10.000Z');
    const account = server({});
    const lock = `${sourceVaultPath('firecrawl', dir)}.lock`;
    const error = await withFileLock(lock, () =>
      accountCredential(
        'firecrawl',
        'Firecrawl',
        deps(vault, account, { lockTimeoutMs: 100 }),
      ).catch((err: unknown) => err),
    );
    expect(refusal(error)).toBe('busy');
    expect((error as AccountRefusal).detail).toBe(lock);
    expect(account.seen).toEqual([]);
  });

  it('marks a refused grant expired, so the next call refuses with no request', async () => {
    const vault = await connected('2026-10-23T12:00:10.000Z');
    const account = server({ refresh: 'invalid_grant' });
    const first = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account)).catch(
      (err: unknown) => err,
    );
    expect(refusal(first)).toBe('signin_expired');
    expect((await readVaultHeader(dir, 'firecrawl'))?.state).toBe('expired');
    const sent = account.seen.length;
    const again = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account)).catch(
      (err: unknown) => err,
    );
    expect(refusal(again)).toBe('signin_expired');
    expect(account.seen.length).toBe(sent);
  });

  it('leaves the sign-in as it was when the sign-in server is down', async () => {
    const vault = await connected('2026-10-23T12:00:10.000Z');
    const account = server({ refresh: 'server_error' });
    const error = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account)).catch(
      (err: unknown) => err,
    );
    expect(refusal(error)).toBe('unreachable');
    expect((await readVaultHeader(dir, 'firecrawl'))?.state).toBe('ok');
  });

  it('sends a pasted key in its own scheme, and never resends one the account refused', async () => {
    const vault = await connected('', {
      kind: 'key',
      secret: { apiKey: 'key-id:key-secret', keyScheme: 'Key' },
    });
    const account = server({});
    const credential = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account));
    expect(credential.headers).toEqual({ authorization: 'Key key-id:key-secret' });
    const error = await accountCredential('firecrawl', 'Firecrawl', deps(vault, account), {
      refused: 'key-id:key-secret',
    }).catch((err: unknown) => err);
    expect(refusal(error)).toBe('signin_expired');
    expect(account.seen).toEqual([]);
  });

  it('refuses an account with no sign-in here', async () => {
    const account = server({});
    const error = await accountCredential('firecrawl', 'Firecrawl', {
      dataDir: dir,
      platform: 'darwin',
      exec: fakeKeychain().exec,
      fetchImpl: account.fetchImpl,
    }).catch((err: unknown) => err);
    expect(refusal(error)).toBe('not_connected');
  });
});
