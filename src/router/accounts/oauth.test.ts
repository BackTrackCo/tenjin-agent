import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliError } from '../../lib/errors';
import { REDIRECT_PORTS } from './loopback';
import { CLIENT_METADATA_URL, revokeSignIn, signIn, type SignInDeps } from './oauth';
import { fakeAccountServer } from './test-support';

/**
 * SIGNING IN, END TO END against a scripted account server: the SDK's
 * discovery, client identity, PKCE and code exchange, Tenjin's redirect on a
 * real 127.0.0.1 listener, and the `state` check. Nothing leaves the test:
 * every request but the browser's redirect goes to the injected fetch.
 */

const MCP = 'https://mcp.example.test/mcp';
const DOCUMENT = 'https://tenjin.example.test/oauth/client-metadata.json';
const ACCOUNT = { id: 'example', label: 'Example', mcpUrl: MCP };

function depsFor(
  server: ReturnType<typeof fakeAccountServer>,
  over: Partial<SignInDeps> = {},
): SignInDeps {
  return {
    fetchImpl: server.fetchImpl,
    open: server.browser,
    notice: () => undefined,
    interactive: false,
    waitMs: 5_000,
    ports: [0],
    clientMetadataUrl: DOCUMENT,
    now: () => 1_000,
    ...over,
  };
}

describe("Tenjin's client document", () => {
  it('lists exactly the redirects a sign-in by it can use, under the id it is sent as', () => {
    const doc = JSON.parse(
      readFileSync(new URL('../fixtures/oauth-client-metadata.json', import.meta.url), 'utf8'),
    ) as { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string };
    expect(doc.client_id).toBe(CLIENT_METADATA_URL);
    expect(doc.redirect_uris).toEqual(
      REDIRECT_PORTS.map((port) => `http://127.0.0.1:${port}/callback`),
    );
    expect(doc.token_endpoint_auth_method).toBe('none');
  });
});

describe('signing in to an account', () => {
  it("uses Tenjin's client document, PKCE and its own state, and hands back the tokens", async () => {
    const server = fakeAccountServer({ mcpUrl: MCP });
    const notices: string[] = [];
    const signed = await signIn(ACCOUNT, depsFor(server, { notice: (l) => notices.push(l) }));
    expect(signed).toMatchObject({
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
      obtainedAt: 1_000,
      clientInformation: { client_id: DOCUMENT },
      discoveryState: { authorizationServerUrl: 'https://auth.example.test' },
    });
    // The approval page: S256 PKCE, a 43-character state, the resource and
    // the document as the client id; no registration was needed.
    const [approval] = server.approvals;
    expect(approval!.origin + approval!.pathname).toBe('https://auth.example.test/authorize');
    expect(approval!.searchParams.get('client_id')).toBe(DOCUMENT);
    expect(approval!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(approval!.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(approval!.searchParams.get('resource')).toBe(MCP);
    expect(approval!.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(server.seen.some(({ url }) => url.endsWith('/register'))).toBe(false);
    // The exchange proves the verifier behind that challenge.
    const exchange = server.seen.find(({ url }) => url.endsWith('/token'))!;
    const form = new URLSearchParams(exchange.body);
    const verifier = form.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      approval!.searchParams.get('code_challenge'),
    );
    expect(form.get('redirect_uri')).toBe(approval!.searchParams.get('redirect_uri'));
    // The person is told where to approve; nothing secret is printed.
    expect(notices[0]).toBe('Approve Tenjin in your browser to connect Example:');
    expect(notices.join('\n')).not.toContain('access-1');
  });

  it('registers a client where the server takes no client document', async () => {
    const server = fakeAccountServer({ mcpUrl: MCP, cimd: false, metadataInChallenge: false });
    const signed = await signIn(ACCOUNT, depsFor(server));
    expect(signed.clientInformation.client_id).toBe('registered-client');
    const registration = server.seen.find(({ url }) => url.endsWith('/register'))!;
    const metadata = JSON.parse(registration.body!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      client_name: 'Tenjin',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    expect(metadata.redirect_uris).toEqual([server.approvals[0]!.searchParams.get('redirect_uri')]);
  });

  it('refuses a server with no sign-in it can use, before any browser opens', async () => {
    let opened = 0;
    const open = async () => {
      opened += 1;
      return true;
    };
    for (const server of [
      fakeAccountServer({ mcpUrl: MCP, cimd: false, dcr: false }),
      fakeAccountServer({ mcpUrl: MCP, openStatus: 200 }),
      fakeAccountServer({
        mcpUrl: MCP,
        authorizationEndpoint: 'http://auth.example.test/authorize',
      }),
    ]) {
      const error = await signIn(ACCOUNT, depsFor(server, { open })).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toMatch(/^Tenjin couldn't sign in to Example: /);
      expect((error as CliError).fix).toContain('tenjin connect example --paste');
    }
    expect(opened).toBe(0);
  });

  it('stops at once when no browser opens and no one is at the terminal', async () => {
    const server = fakeAccountServer({ mcpUrl: MCP });
    const started = Date.now();
    const error = await signIn(
      ACCOUNT,
      depsFor(server, { open: async () => false, waitMs: 60_000 }),
    ).catch((err: unknown) => err);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((error as CliError).message).toBe(
      "Tenjin couldn't open a browser here, so it can't sign in to Example from this session. Nothing was saved.",
    );
    expect(server.seen.some(({ url }) => url.endsWith('/token'))).toBe(false);
  });

  it('saves nothing when the person declines', async () => {
    const server = fakeAccountServer({ mcpUrl: MCP });
    const error = await signIn(ACCOUNT, depsFor(server, { open: server.decline })).catch(
      (err: unknown) => err,
    );
    expect((error as CliError).message).toBe(
      'The sign-in to Example was declined, so nothing was connected.',
    );
    expect(server.seen.some(({ url }) => url.endsWith('/token'))).toBe(false);
  });

  it('never takes a redirect with another state', async () => {
    const server = fakeAccountServer({ mcpUrl: MCP });
    const forged = async (url: string) => {
      const redirect = new URL(url).searchParams.get('redirect_uri');
      void fetch(`${redirect}?code=code-1&state=forged`).catch(() => undefined);
      return true;
    };
    const error = await signIn(ACCOUNT, depsFor(server, { open: forged, waitMs: 300 })).catch(
      (err: unknown) => err,
    );
    expect((error as CliError).message).toBe(
      'The sign-in was not finished in time. Nothing was saved.',
    );
    expect(server.seen.some(({ url }) => url.endsWith('/token'))).toBe(false);
  });
});

describe('signing out', () => {
  it('revokes each token where the server lets a client, and says when it cannot', async () => {
    const server = fakeAccountServer({ mcpUrl: MCP });
    const secret = {
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
      clientInformation: { client_id: DOCUMENT },
      discoveryState: {
        authorizationServerMetadata: { revocation_endpoint: 'https://auth.example.test/revoke' },
      },
    };
    expect(await revokeSignIn(secret, server.fetchImpl)).toBe('revoked');
    const revoked = server.seen
      .filter(({ url }) => url.endsWith('/revoke'))
      .map(({ body }) => Object.fromEntries(new URLSearchParams(body)));
    expect(revoked).toEqual([
      { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: DOCUMENT },
      { token: 'access-1', token_type_hint: 'access_token', client_id: DOCUMENT },
    ]);
    expect(await revokeSignIn({ ...secret, discoveryState: {} }, server.fetchImpl)).toBe(
      'unsupported',
    );
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await revokeSignIn(secret, down)).toBe('failed');
  });
});
