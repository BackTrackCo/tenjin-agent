import { StoreExecError, type ExecFn } from '../../lib/os-store';

/**
 * A FAKE macOS KEYCHAIN for the account tests: the `security` commands the
 * keychain backend sends, answered from a map. Nothing here runs a process,
 * so no test reaches a real keychain. `locked` makes every call answer as a
 * keychain that refuses, the way a locked one does.
 */
export function fakeKeychain(opts: { locked?: boolean } = {}): {
  exec: ExecFn;
  entries: Map<string, string>;
  calls: { args: string[]; stdin?: string }[];
} {
  const entries = new Map<string, string>();
  const calls: { args: string[]; stdin?: string }[] = [];
  const refuse = () =>
    new StoreExecError('security', { code: 36, stderr: 'User interaction is not allowed.' });
  const exec: ExecFn = async (file, args, stdin) => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    if (file !== 'security') throw new StoreExecError(file, { code: 'ENOENT', enoent: true });
    if (opts.locked === true) throw refuse();
    const [verb] = args;
    const at = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
    if (verb === 'default-keychain') return { stdout: '"/login.keychain-db"\n', stderr: '' };
    if (verb === 'find-generic-password') {
      const value = entries.get(`${at('-s')}/${at('-a')}`);
      if (value === undefined) throw new StoreExecError('security', { code: 44 });
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (verb === 'delete-generic-password') {
      if (!entries.delete(`${at('-s')}/${at('-a')}`))
        throw new StoreExecError('security', { code: 44 });
      return { stdout: '', stderr: '' };
    }
    if (verb === '-i') {
      const line = /^add-generic-password -s (\S+) -a (\S+) -w '([^']*)'( -U)?\n$/.exec(
        stdin ?? '',
      );
      if (line === null) throw new StoreExecError('security', { code: 1 });
      const [, service, account, value, update] = line;
      const key = `${service}/${account}`;
      if (entries.has(key) && update === undefined)
        throw new StoreExecError('security', { code: 45 });
      entries.set(key, value!);
      return { stdout: '', stderr: '' };
    }
    throw new StoreExecError('security', { code: 1 });
  };
  return { exec, entries, calls };
}

/** One request the fake account server saw. */
export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeAccountServerOptions {
  /** The account's MCP server. */
  mcpUrl: string;
  /** The authorization server's origin. */
  issuer?: string;
  /** It takes Tenjin's client document (CIMD). Default true. */
  cimd?: boolean;
  /** It offers dynamic registration. Default true. */
  dcr?: boolean;
  /** Names its resource metadata in the 401, as Firecrawl and fal do. Default true. */
  metadataInChallenge?: boolean;
  /** The approval page the metadata names. */
  authorizationEndpoint?: string;
  /** Lists a revocation endpoint. Default true. */
  revocation?: boolean;
  /** The `initialize` with no credential answers this instead of 401. */
  openStatus?: number;
  /** How a refresh grant is answered: new tokens (the default), a grant the
   *  server will never take again, or a server error. */
  refresh?: 'ok' | 'invalid_grant' | 'server_error';
}

/**
 * A FAKE ACCOUNT SERVER behind an injected fetch: the MCP server's 401, its
 * resource metadata, its authorization server's metadata, registration,
 * token and revocation endpoints, all scripted. `browser` stands in for the
 * person approving: it sends the redirect the authorization server would,
 * to the real 127.0.0.1 listener the sign-in opened.
 */
export function fakeAccountServer(opts: FakeAccountServerOptions): {
  fetchImpl: typeof fetch;
  seen: SeenRequest[];
  approvals: URL[];
  /** The refresh token each refresh grant sent, in order. */
  refreshes: string[];
  browser: (url: string) => Promise<boolean>;
  decline: (url: string) => Promise<boolean>;
} {
  const mcp = new URL(opts.mcpUrl);
  const issuer = opts.issuer ?? 'https://auth.example.test';
  const prm = `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === '/' ? '' : mcp.pathname}`;
  const seen: SeenRequest[] = [];
  const approvals: URL[] = [];
  const refreshes: string[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : init?.body?.toString();
    seen.push({ url, method, headers, ...(body !== undefined ? { body } : {}) });
    if (url === opts.mcpUrl && method === 'POST') {
      if (opts.openStatus !== undefined) return json(opts.openStatus, {});
      return json(
        401,
        { error: 'invalid_token' },
        {
          'www-authenticate':
            opts.metadataInChallenge === false
              ? 'Bearer realm="OAuth", error="invalid_token"'
              : `Bearer resource_metadata="${prm}", scope="read offline_access"`,
        },
      );
    }
    if (url === prm || url === `${mcp.origin}/.well-known/oauth-protected-resource`) {
      return json(200, {
        resource: opts.mcpUrl,
        authorization_servers: [issuer],
        scopes_supported: ['read', 'offline_access'],
      });
    }
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return json(200, {
        issuer,
        authorization_endpoint: opts.authorizationEndpoint ?? `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(opts.dcr !== false ? { registration_endpoint: `${issuer}/register` } : {}),
        ...(opts.revocation !== false ? { revocation_endpoint: `${issuer}/revoke` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(opts.cimd !== false ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (url === `${issuer}/register` && method === 'POST') {
      const metadata = JSON.parse(body ?? '{}') as Record<string, unknown>;
      return json(201, { ...metadata, client_id: 'registered-client' });
    }
    if (url === `${issuer}/token` && method === 'POST') {
      const form = new URLSearchParams(body ?? '');
      if (form.get('grant_type') === 'refresh_token') {
        refreshes.push(form.get('refresh_token') ?? '');
        if (opts.refresh === 'invalid_grant') return json(400, { error: 'invalid_grant' });
        if (opts.refresh === 'server_error') return json(503, { error: 'temporarily_unavailable' });
        const n = refreshes.length + 1;
        return json(200, {
          access_token: `access-${n}`,
          refresh_token: `refresh-${n}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (form.get('grant_type') !== 'authorization_code' || form.get('code') !== 'code-1')
        return json(400, { error: 'invalid_grant' });
      if ((form.get('code_verifier') ?? '').length < 43)
        return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url === `${issuer}/revoke` && method === 'POST') return new Response(null, { status: 200 });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  const redirectFrom = (url: string, query: string) => {
    const approval = new URL(url);
    approvals.push(approval);
    const redirect = approval.searchParams.get('redirect_uri');
    const state = approval.searchParams.get('state');
    // The browser: a real request to the listener on 127.0.0.1, not awaited,
    // as a person approving some seconds later would send it.
    void fetch(`${redirect}?${query}&state=${encodeURIComponent(state ?? '')}`).catch(
      () => undefined,
    );
    return Promise.resolve(true);
  };
  return {
    fetchImpl,
    seen,
    approvals,
    refreshes,
    browser: (url) => redirectFrom(url, 'code=code-1'),
    decline: (url) => redirectFrom(url, 'error=access_denied'),
  };
}
