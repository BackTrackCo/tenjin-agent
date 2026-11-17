import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAccountTools } from './call';
import { AccountRefused, openAccountSession } from './client';
import { AccountRefusal, accountCredential } from './credential';
import { accountFetch, responseOf, type AccountServer, type AccountTransport } from './fetch';
import { revokeSignIn, signIn } from './oauth';
import { fakeAccountServer, fakeKeychain } from './test-support';
import { clearVaultKeyCache, writeVault, type VaultDeps } from './vault';

/**
 * WHAT A CONNECTED ACCOUNT'S REQUESTS MAY REACH, by who named the host. The
 * server the user typed is theirs: its own origin goes out as named, a port,
 * a local name and http on this machine included. The router's server, and
 * every host a server's metadata names on another origin, is held to a paid
 * call's check and pinned to the address it validated, with loopback or the
 * private network only where the user typed a server there. The resolver and
 * the transport are the paid path's seams; nothing here opens a socket but
 * the sign-in's own listener on 127.0.0.1.
 */

const ANSWERS: Record<string, string> = {
  'mcp.example.test': '93.184.216.34',
  'auth.example.test': '93.184.216.35',
  localhost: '127.0.0.1',
  'rebind.example.test': '10.0.0.5',
  'loop.example.test': '127.0.0.1',
};
const DESTINATION = {
  resolveHostname: async (name: string) => {
    const address = ANSWERS[name];
    if (address === undefined) throw new Error(`ENOTFOUND ${name}`);
    return [{ address, family: 4 }];
  },
};

function recorder() {
  const seen: { url: string; address: string; method: string; body: string; auth: string }[] = [];
  const transport: AccountTransport = async (request, pinned) => {
    seen.push({
      url: request.url,
      address: pinned?.address ?? 'as named',
      method: request.method,
      body: await request.text(),
      auth: request.headers.get('authorization') ?? '',
    });
    return new Response('{}', { status: 200 });
  };
  return { seen, transport };
}

/** Where each URL went for an account at `server`: the pinned address, `as
 *  named` on the typed server's own origin, or `refused`. */
async function reached(server: AccountServer, urls: string[]): Promise<Record<string, string>> {
  const { seen, transport } = recorder();
  const send = accountFetch(server, { transport, destination: DESTINATION });
  const out: Record<string, string> = {};
  for (const url of urls) {
    const before = seen.length;
    out[url] = await send(url).then(
      () => seen[before]?.address ?? 'unsent',
      () => 'refused',
    );
  }
  return out;
}

describe('a request for an account', () => {
  it("goes to the typed server's own origin as named: any port, a local name, http on this machine", async () => {
    expect(
      await reached({ mcpUrl: 'http://localhost:3000/mcp', typed: true }, [
        'http://localhost:3000/mcp',
        'http://localhost:3000/.well-known/oauth-protected-resource/mcp',
      ]),
    ).toEqual({
      'http://localhost:3000/mcp': 'as named',
      'http://localhost:3000/.well-known/oauth-protected-resource/mcp': 'as named',
    });
    expect(
      await reached({ mcpUrl: 'https://mcp.example.test:8443/mcp', typed: true }, [
        'https://mcp.example.test:8443/mcp',
      ]),
    ).toEqual({ 'https://mcp.example.test:8443/mcp': 'as named' });
    expect(
      await reached({ mcpUrl: 'https://nas.local/mcp', typed: true }, ['https://nas.local/mcp']),
    ).toEqual({ 'https://nas.local/mcp': 'as named' });
  });

  it('holds the router-named server to public HTTPS, any port, pinned to the address checked', async () => {
    const { seen, transport } = recorder();
    const send = accountFetch(
      { mcpUrl: 'https://mcp.example.test/mcp' },
      { transport, destination: DESTINATION },
    );
    const res = await send('https://mcp.example.test/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      body: '{"id":1}',
    });
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
    // Typed by the user, the same address goes as named; named by the router,
    // a local one is refused before anything is sent.
    expect(
      await reached({ mcpUrl: 'https://mcp.example.test/mcp' }, [
        'https://mcp.example.test:8443/mcp',
        'https://rebind.example.test/mcp',
        'https://127.0.0.1/mcp',
        'http://mcp.example.test/mcp',
        'http://localhost:3000/mcp',
      ]),
    ).toEqual({
      'https://mcp.example.test:8443/mcp': '93.184.216.34',
      'https://rebind.example.test/mcp': 'refused',
      'https://127.0.0.1/mcp': 'refused',
      'http://mcp.example.test/mcp': 'refused',
      'http://localhost:3000/mcp': 'refused',
    });
    await expect(send('https://rebind.example.test/mcp')).rejects.toThrow(
      'rebind.example.test is not a public HTTPS address',
    );
  });

  it('lets a server typed on this machine name a sign-in on this machine, never one on the network', async () => {
    expect(
      await reached({ mcpUrl: 'http://localhost:3000/mcp', typed: true }, [
        'http://localhost:4000/.well-known/oauth-authorization-server',
        'http://127.0.0.1:4000/token',
        'https://auth.example.test/token',
        'https://10.0.0.5/token',
        'https://rebind.example.test/token',
        'https://169.254.169.254/latest/meta-data',
        'http://169.254.169.254/latest/meta-data',
        'http://auth.example.test/token',
        'http://loop.example.test/token',
      ]),
    ).toEqual({
      'http://localhost:4000/.well-known/oauth-authorization-server': '127.0.0.1',
      'http://127.0.0.1:4000/token': '127.0.0.1',
      'https://auth.example.test/token': '93.184.216.35',
      'https://10.0.0.5/token': 'refused',
      'https://rebind.example.test/token': 'refused',
      'https://169.254.169.254/latest/meta-data': 'refused',
      'http://169.254.169.254/latest/meta-data': 'refused',
      'http://auth.example.test/token': 'refused',
      // Plain http goes to this machine by its name, not by a name that
      // happens to answer with a loopback address.
      'http://loop.example.test/token': 'refused',
    });
  });

  it('never lets a public server name a host on this machine or the network', async () => {
    expect(
      await reached({ mcpUrl: 'https://mcp.example.test/mcp', typed: true }, [
        'https://auth.example.test/token',
        'http://localhost:4000/token',
        'https://localhost:4000/token',
        'https://127.0.0.1/token',
        'https://loop.example.test/token',
        'https://192.168.1.6/token',
      ]),
    ).toEqual({
      'https://auth.example.test/token': '93.184.216.35',
      'http://localhost:4000/token': 'refused',
      'https://localhost:4000/token': 'refused',
      'https://127.0.0.1/token': 'refused',
      'https://loop.example.test/token': 'refused',
      'https://192.168.1.6/token': 'refused',
    });
  });

  it('lets a server typed at a private address name the private network, never this machine or metadata', async () => {
    expect(
      await reached({ mcpUrl: 'https://192.168.1.5/mcp', typed: true }, [
        'https://192.168.1.5/mcp',
        'https://192.168.1.6/token',
        'https://rebind.example.test/token',
        'https://127.0.0.1/token',
        'https://169.254.169.254/latest/meta-data',
        'https://[fd00:ec2::254]/latest/meta-data',
        'http://192.168.1.6/token',
      ]),
    ).toEqual({
      'https://192.168.1.5/mcp': 'as named',
      'https://192.168.1.6/token': '192.168.1.6',
      'https://rebind.example.test/token': '10.0.0.5',
      'https://127.0.0.1/token': 'refused',
      'https://169.254.169.254/latest/meta-data': 'refused',
      'https://[fd00:ec2::254]/latest/meta-data': 'refused',
      'http://192.168.1.6/token': 'refused',
    });
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

  /** An expired sign-in sealed for the account at `server`, its sign-in at `auth`. */
  async function expiredSignIn(server: AccountServer, auth: string, now: number) {
    const keychain = fakeKeychain();
    const vault: VaultDeps = { dataDir: dir, platform: 'darwin', exec: keychain.exec };
    await writeVault(
      'local',
      'Local',
      {
        kind: 'oauth',
        mcpUrl: server.mcpUrl,
        ...(server.typed === true ? { typed: true as const } : {}),
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
          authorizationServerUrl: auth,
          authorizationServerMetadata: {
            issuer: auth,
            authorization_endpoint: `${auth}/authorize`,
            token_endpoint: `${auth}/token`,
            response_types_supported: ['code'],
          },
        },
      },
      vault,
    );
    return vault;
  }

  it('goes out checked when the router named the server: the sign-in, the session, a refresh and a sign-out', async () => {
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
      await revokeSignIn(
        {
          tokens: { refresh_token: 'refresh-1' },
          discoveryState: {
            authorizationServerMetadata: { revocation_endpoint: `${local}/revoke` },
          },
        },
        { mcpUrl: 'https://mcp.example.test/mcp' },
      ),
    ).toBe('failed');

    const now = Date.parse('2026-10-23T12:00:00.000Z');
    const vault = await expiredSignIn({ mcpUrl: 'https://mcp.example.test/mcp' }, local, now);
    const refresh = accountCredential('local', 'Local', { ...vault, now: () => now });
    await expect(refresh).rejects.toBeInstanceOf(AccountRefusal);
    await expect(refresh).rejects.toMatchObject({ reason: 'unreachable' });

    expect(unchecked).not.toHaveBeenCalled();
  });

  it('reaches a server the user typed on this machine: the sign-in, the session, a refresh and a sign-out', async () => {
    // `tenjin connect http://localhost:3000/mcp`, its sign-in on the same
    // origin: the ordinary fetch stands in for it. The browser's redirect to
    // the sign-in's own listener goes out for real.
    const mcpUrl = 'http://localhost:3000/mcp';
    const origin = 'http://localhost:3000';
    const server = fakeAccountServer({ mcpUrl, issuer: origin });
    const real = globalThis.fetch;
    const reachedHere: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${origin}/`)) return real(input, init);
      reachedHere.push(url);
      const body =
        init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body;
      return server.fetchImpl(url, { ...init, ...(body !== undefined ? { body } : {}) });
    });
    const typed = { mcpUrl, typed: true };

    const signed = await signIn(
      { id: 'localhost', label: 'localhost', ...typed },
      {
        open: server.browser,
        notice: () => undefined,
        interactive: false,
        waitMs: 5_000,
        ports: [0],
        clientMetadataUrl: 'https://tenjin.example.test/oauth/client-metadata.json',
      },
    );
    expect(signed.tokens.access_token).toBe('access-1');
    // Its approval page is on this machine too, and opened there.
    expect(server.approvals.map((url) => url.origin)).toEqual([origin]);

    // The session reached the server, which wants a sign-in for it.
    await expect(
      openAccountSession(mcpUrl, {}, { timeoutMs: 1_000, typed: true }),
    ).rejects.toBeInstanceOf(AccountRefused);

    const now = Date.parse('2026-10-23T12:00:00.000Z');
    const vault = await expiredSignIn(typed, origin, now);
    const fresh = await accountCredential('local', 'Local', { ...vault, now: () => now });
    expect(fresh).toMatchObject({
      mcpUrl,
      typed: true,
      headers: { authorization: 'Bearer access-2' },
    });
    // A call on the sealed account opens its session there too.
    const before = reachedHere.filter((url) => url === mcpUrl).length;
    await listAccountTools(
      { id: 'local', label: 'Local' },
      { ...vault, now: () => now, deadline: now + 60_000, callTimeoutMs: 1_000 },
    );
    expect(reachedHere.filter((url) => url === mcpUrl).length).toBeGreaterThan(before);

    expect(
      await revokeSignIn(
        {
          tokens: { refresh_token: 'refresh-2' },
          discoveryState: {
            authorizationServerMetadata: { revocation_endpoint: `${origin}/revoke` },
          },
        },
        typed,
      ),
    ).toBe('revoked');
    expect(reachedHere).toEqual(
      expect.arrayContaining([mcpUrl, `${origin}/token`, `${origin}/revoke`]),
    );
  });
});
