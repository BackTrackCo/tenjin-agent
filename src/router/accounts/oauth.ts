import { randomBytes } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import pkg from '../../../package.json';
import { CliError } from '../../lib/errors';
import { PRODUCTION_ORIGIN } from '../../lib/production-origin';
import { openRedirect, REDIRECT_PORTS } from './loopback';

/**
 * SIGNING IN TO A CONNECTED ACCOUNT, through the MCP SDK's `auth()`. Every MCP
 * server that follows the MCP authorization spec signs a client in the same
 * way, so one flow serves Apify, fal, Firecrawl and an address the user
 * gives: discovery, the client's identity, the browser approval with PKCE, and
 * the code exchange are the SDK's. Tenjin supplies the redirect (loopback.ts),
 * a provider that holds everything in memory for this one sign-in, and the
 * `state` check, which the SDK leaves to its caller.
 *
 * The client's identity is Tenjin's published client document (CIMD) where
 * the authorization server takes one, and a dynamic registration where it
 * does not, as the SDK chooses. With the document the redirect uses one of
 * the fixed ports it lists, since such a server may match them exactly; a
 * registration names whatever free port this sign-in got.
 *
 * The SDK modules load through a dynamic import only (decided37 #16). No
 * token, code or key ever reaches Tenjin's server.
 */

/** Tenjin's client metadata document: public https, as the spec requires. */
export const CLIENT_METADATA_URL = `${PRODUCTION_ORIGIN}/oauth/client-metadata.json`;

/** Every request this flow makes, bounded. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What a sign-in hands back to be sealed in the vault. */
export interface SignedIn {
  tokens: OAuthTokens;
  obtainedAt: number;
  clientInformation: OAuthClientInformationMixed;
  discoveryState: OAuthDiscoveryState;
}

/**
 * THE PROVIDER FOR ONE SIGN-IN, in memory only: nothing it holds outlives the
 * command unless the caller seals it in the vault.
 */
export class ConnectProvider implements OAuthClientProvider {
  readonly clientMetadataUrl: string | undefined;
  readonly #state: string;
  #verifier: string | undefined;
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #discovery: OAuthDiscoveryState | undefined;

  constructor(
    private readonly opts: {
      redirectUrl: string;
      /** The `state` the redirect listener waits for. */
      state: string;
      clientMetadataUrl?: string;
      discovery?: OAuthDiscoveryState;
      onAuthorizationUrl: (url: URL) => void | Promise<void>;
    },
  ) {
    this.clientMetadataUrl = opts.clientMetadataUrl;
    this.#state = opts.state;
    this.#discovery = opts.discovery;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  /** What a dynamic registration sends: a public client on this redirect. */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Tenjin',
      client_uri: PRODUCTION_ORIGIN,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      software_id: 'tenjin-cli',
      software_version: pkg.version,
    };
  }

  state(): string {
    return this.#state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.#client = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.opts.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new Error('no sign-in was started');
    return this.#verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.#client = undefined;
    if (scope === 'all' || scope === 'tokens') this.#tokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.#verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.#discovery = undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

export interface SignInDeps {
  fetchImpl: typeof fetch;
  /** Opens the approval page; false when no browser could open. */
  open: (url: string) => Promise<boolean>;
  /** One line to the person, on stderr. */
  notice: (line: string) => void;
  /** A person is at this terminal: a link that did not open can still be clicked. */
  interactive: boolean;
  /** How long to wait for the approval. */
  waitMs: number;
  /** Test seam: the ports the redirect may use. */
  ports?: readonly number[];
  /** Test seam: Tenjin's client document. */
  clientMetadataUrl?: string;
  now?: () => number;
}

/** What an account's server says to a request with no credential. */
interface Challenge {
  status: number;
  resourceMetadataUrl?: URL;
  scope?: string;
}

/** The unauthenticated `initialize` a client sends first: some servers name
 *  their resource metadata only in the 401 it gets. */
async function challenge(mcpUrl: string, fetchImpl: typeof fetch): Promise<Challenge> {
  const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
  const res = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tenjin', version: pkg.version },
      },
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => undefined);
  if (res.status !== 401) return { status: res.status };
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
  return {
    status: res.status,
    ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** One line of a server's error, bounded, for a message a person reads. */
function said(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function cannotSignIn(label: string, id: string, why: string): CliError {
  return new CliError(
    'REFUSED',
    `Tenjin couldn't sign in to ${label}: ${why}. Nothing was saved.`,
    {
      fix: `If ${label} gives you an API key, the user can run \`tenjin connect ${id} --paste\` in their own terminal.`,
    },
  );
}

/**
 * Sign in to the MCP server at `mcpUrl` in the user's browser, and hand back
 * what to seal. The redirect is caught on 127.0.0.1 and closed whatever
 * happens; a redirect whose `state` is not this sign-in's is never taken.
 */
export async function signIn(
  account: { id: string; label: string; mcpUrl: string },
  deps: SignInDeps,
): Promise<SignedIn> {
  const { id, label, mcpUrl } = account;
  const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
    deps.fetchImpl(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let first: Challenge;
  try {
    first = await challenge(mcpUrl, deps.fetchImpl);
  } catch (err) {
    throw new CliError(
      'NETWORK_ERROR',
      `Tenjin couldn't reach ${label} (${said(err)}). Nothing was saved.`,
      {
        fix: 'Check the network and the address, then run the command again.',
      },
    );
  }
  if (first.status >= 200 && first.status < 300)
    throw cannotSignIn(label, id, 'it answered without asking anyone to sign in');
  if (first.status !== 401) throw cannotSignIn(label, id, `it answered ${first.status}`);

  const sdk = await import('@modelcontextprotocol/sdk/client/auth.js');
  let info: Awaited<ReturnType<typeof sdk.discoverOAuthServerInfo>>;
  try {
    info = await sdk.discoverOAuthServerInfo(mcpUrl, {
      ...(first.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: first.resourceMetadataUrl }
        : {}),
      fetchFn,
    });
  } catch (err) {
    throw cannotSignIn(label, id, `its sign-in could not be found (${said(err)})`);
  }
  const metadata = info.authorizationServerMetadata;
  const clientMetadataUrl = deps.clientMetadataUrl ?? CLIENT_METADATA_URL;
  const byDocument = metadata?.client_id_metadata_document_supported === true;
  if (metadata === undefined || (!byDocument && metadata.registration_endpoint === undefined))
    throw cannotSignIn(label, id, "it doesn't offer a sign-in Tenjin can use");

  const state = randomBytes(32).toString('base64url');
  const redirect = await openRedirect({
    state,
    timeoutMs: deps.waitMs,
    ...(deps.ports !== undefined
      ? { ports: deps.ports }
      : byDocument
        ? { ports: REDIRECT_PORTS }
        : {}),
  });
  try {
    const discovery: OAuthDiscoveryState = {
      ...info,
      ...(first.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: first.resourceMetadataUrl.toString() }
        : {}),
    };
    const provider = new ConnectProvider({
      redirectUrl: redirect.redirectUrl,
      state,
      clientMetadataUrl,
      discovery,
      onAuthorizationUrl: async (url) => {
        // The approval page comes from the server's own metadata: only an
        // https page is ever opened.
        if (url.protocol !== 'https:')
          throw cannotSignIn(label, id, 'its approval page is not an https address');
        deps.notice(`Approve Tenjin in your browser to connect ${label}:`);
        deps.notice(`  ${url.href}`);
        if (await deps.open(url.href)) return;
        if (!deps.interactive) {
          throw new CliError(
            'REFUSED',
            `Tenjin couldn't open a browser here, so it can't sign in to ${label} from this session. Nothing was saved.`,
            {
              fix: `The user can run \`tenjin connect ${id}\` in their own terminal, or \`tenjin connect ${id} --paste\` with a key.`,
            },
          );
        }
        deps.notice("Couldn't open a browser: open the link above on this machine.");
      },
    });
    const options = {
      serverUrl: mcpUrl,
      ...(first.scope !== undefined ? { scope: first.scope } : {}),
      ...(first.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: first.resourceMetadataUrl }
        : {}),
      fetchFn,
    };
    let started: 'AUTHORIZED' | 'REDIRECT';
    try {
      started = await sdk.auth(provider, options);
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw cannotSignIn(label, id, `the sign-in could not start (${said(err)})`);
    }
    if (started === 'REDIRECT') {
      const back = await redirect.wait();
      if ('error' in back) {
        throw new CliError(
          'REFUSED',
          back.error === 'access_denied'
            ? `The sign-in to ${label} was declined, so nothing was connected.`
            : `${label} did not finish the sign-in (${back.error}). Nothing was saved.`,
          { fix: `Run \`tenjin connect ${id}\` again to try once more.` },
        );
      }
      try {
        await sdk.auth(provider, { ...options, authorizationCode: back.code });
      } catch (err) {
        throw cannotSignIn(label, id, `the sign-in was not accepted (${said(err)})`);
      }
    }
    const tokens = provider.tokens();
    const client = provider.clientInformation();
    const discovered = provider.discoveryState();
    if (tokens === undefined || client === undefined || discovered === undefined)
      throw cannotSignIn(label, id, 'no sign-in came back');
    return {
      tokens,
      obtainedAt: deps.now?.() ?? Date.now(),
      clientInformation: client,
      discoveryState: discovered,
    };
  } finally {
    redirect.close();
  }
}

/**
 * Sign the account out where its authorization server lets a client do so
 * (RFC 7009): each token this machine holds, refresh token first. Best
 * effort and bounded; `unsupported` when the server has no revocation
 * endpoint, so only the local copy goes.
 */
export async function revokeSignIn(
  secret: {
    tokens?: Record<string, unknown>;
    clientInformation?: Record<string, unknown>;
    discoveryState?: Record<string, unknown>;
  },
  fetchImpl: typeof fetch,
): Promise<'revoked' | 'unsupported' | 'failed'> {
  const metadata = (secret.discoveryState?.authorizationServerMetadata ?? {}) as {
    revocation_endpoint?: unknown;
  };
  const endpoint =
    typeof metadata.revocation_endpoint === 'string' ? metadata.revocation_endpoint : undefined;
  if (endpoint === undefined || !URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:')
    return 'unsupported';
  const clientId = secret.clientInformation?.client_id;
  const tokens = (['refresh_token', 'access_token'] as const).flatMap((hint) => {
    const token = secret.tokens?.[hint];
    return typeof token === 'string' && token.length > 0 ? [{ hint, token }] : [];
  });
  if (tokens.length === 0) return 'unsupported';
  let ok = true;
  for (const { hint, token } of tokens) {
    const body = new URLSearchParams({ token, token_type_hint: hint });
    if (typeof clientId === 'string') body.set('client_id', clientId);
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status !== 200) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok ? 'revoked' : 'failed';
}
