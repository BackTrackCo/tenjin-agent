import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAccountSession } from './client';
import { AccountRefusal, accountCredential } from './credential';
import { accountFetchWith, responseOf, type AccountTransport } from './fetch';
import { revokeSignIn, signIn } from './oauth';
import { fakeKeychain } from './test-support';
import { clearVaultKeyCache, writeVault } from './vault';

/**
 * EVERY REQUEST TO A CONNECTED ACCOUNT'S HOSTS is held to the paid call's
 * destination check and connected to the address it validated (Greptile on
 * plan 37: the router's `mcpUrl`, and the sign-in's endpoints from the
 * server's own metadata, went out on an ordinary fetch after a scheme check
 * alone). The resolver and the transport are the paid path's seams; nothing
 * here opens a socket.
 */

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

function recorder() {
  const seen: { url: string; address: string; method: string; body: string; auth: string }[] = [];
  const transport: AccountTransport = async (target, request) => {
    seen.push({
      url: target.url.href,
      address: target.address,
      method: request.method,
      body: await request.text(),
      auth: request.headers.get('authorization') ?? '',
    });
    return new Response('{}', { status: 200 });
  };
  return { seen, transport };
}

describe('a request to an account host', () => {
  it('connects to the address the check validated, and sends the request as given', async () => {
    const { seen, transport } = recorder();
    const res = await accountFetchWith({ transport, destination: PUBLIC })(
      'https://mcp.example.test/mcp',
      { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{"id":1}' },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        url: 'https://mcp.example.test/mcp',
        address: '93.184.216.34',
        method: 'POST',
        body: '{"id":1}',
        auth: 'Bearer t',
      },
    ]);
  });

  it('never connects to a name that resolves onto the local network, or to a local address', async () => {
    const { seen, transport } = recorder();
    const rebound = accountFetchWith({
      transport,
      destination: { resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }] },
    });
    await expect(rebound('https://mcp.example.test/mcp')).rejects.toThrow(
      'mcp.example.test is not a public HTTPS address',
    );
    const direct = accountFetchWith({ transport, destination: PUBLIC });
    await expect(direct('https://127.0.0.1/mcp')).rejects.toThrow('not a public HTTPS address');
    await expect(direct('http://mcp.example.test/mcp')).rejects.toThrow(
      'not a public HTTPS address',
    );
    expect(seen).toEqual([]);
  });

  it('reads the pinned answer as fetch would: every header value, the body, and none on a 204', async () => {
    const answer = (status: number, body: string[], headers: Record<string, string | string[]>) =>
      Object.assign(Readable.from(body.map((chunk) => Buffer.from(chunk))), {
        statusCode: status,
        statusMessage: '',
        headers,
      }) as unknown as IncomingMessage;
    const ok = responseOf(
      answer(200, ['{"a":', '1}'], {
        'content-type': 'application/json',
        'set-cookie': ['a=1', 'b=2'],
      }),
      'POST',
    );
    expect(ok.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await ok.json()).toEqual({ a: 1 });
    // The session's end is often answered 204: a body there would throw.
    const ended = responseOf(answer(204, [], {}), 'DELETE');
    expect(ended.status).toBe(204);
    expect(ended.body).toBeNull();
  });
});

describe('every account request', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenjin-account-fetch-'));
    clearVaultKeyCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('goes out checked by default: the sign-in, the session, a refresh and a sign-out', async () => {
    // An ordinary fetch, which skips the check, answers nothing here.
    const unchecked = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('sent on an unchecked fetch'));
    const local = 'https://127.0.0.1';

    await expect(
      signIn(
        { id: 'local', label: 'Local', mcpUrl: `${local}/mcp` },
        { open: async () => false, notice: () => undefined, interactive: false, waitMs: 1_000 },
      ),
    ).rejects.toThrow('127.0.0.1 is not a public HTTPS address');

    await expect(openAccountSession(`${local}/mcp`, {}, { timeoutMs: 1_000 })).rejects.toThrow(
      'not a public HTTPS address',
    );

    expect(
      await revokeSignIn({
        tokens: { refresh_token: 'refresh-1' },
        discoveryState: { authorizationServerMetadata: { revocation_endpoint: `${local}/revoke` } },
      }),
    ).toBe('failed');

    const keychain = fakeKeychain();
    const vault = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    const now = Date.parse('2026-10-23T12:00:00.000Z');
    await writeVault(
      'local',
      'Local',
      {
        kind: 'oauth',
        mcpUrl: 'https://mcp.example.test/mcp',
        connectedAt: new Date(now - 3_600_000).toISOString(),
        // Expired: the credential is refreshed first.
        expiresAt: new Date(now - 1_000).toISOString(),
        state: 'ok',
        missingTools: [],
      },
      {
        tokens: { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' },
        obtainedAt: now - 3_600_000,
        clientInformation: { client_id: 'https://tenjin.sh/oauth/client-metadata.json' },
        discoveryState: {
          authorizationServerUrl: local,
          authorizationServerMetadata: {
            issuer: local,
            authorization_endpoint: `${local}/authorize`,
            token_endpoint: `${local}/token`,
            response_types_supported: ['code'],
          },
        },
      },
      vault,
    );
    const refresh = accountCredential('local', 'Local', { ...vault, now: () => now });
    await expect(refresh).rejects.toBeInstanceOf(AccountRefusal);
    await expect(refresh).rejects.toMatchObject({ reason: 'unreachable' });

    expect(unchecked).not.toHaveBeenCalled();
  });
});
