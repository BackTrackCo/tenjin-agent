import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { composeUserAgent } from '../../lib/client-meta';
import {
  addressClassOf,
  isLoopbackHost,
  resolvePublicDestination,
  type AddressClass,
  type DestinationOptions,
} from '../../lib/destination';
import { CliError } from '../../lib/errors';
import { pinnedHttp, type PinnedTarget } from '../paid';

/**
 * EVERY REQUEST TO A CONNECTED ACCOUNT'S HOSTS, through one fetch: the MCP
 * server's first 401 and the sign-in's discovery, registration, token and
 * revocation requests (`oauth.ts`), a refresh (`credential.ts`), and the MCP
 * session itself (`client.ts`). What a request may reach depends on who
 * named its host, as the MCP spec's security practices and RFC 9728 §7.7 ask:
 *
 * - THE SERVER THE USER TYPED (`tenjin connect http://localhost:3000/mcp`)
 *   is theirs to name. Every request to its own origin goes out as it is:
 *   any port, any address, a `.local` name, http on this machine. Its address
 *   was checked when it was connected (`decision.ts`'s `isAccountUrl`).
 * - A SERVER THE ROUTER NAMED (fal, Apify, Firecrawl), and every host a
 *   server's own metadata names on another origin (its authorization server,
 *   that server's token, registration and revocation endpoints), was picked
 *   by someone other than the user. Each is held to a paid call's check
 *   (`lib/destination.ts`): https, every address the name resolves to public,
 *   and the socket connected to the one address that was checked
 *   ({@link pinnedHttp}), so a name that turns private between the check and
 *   the connect gets nothing. Any port. Beyond public addresses, only a
 *   typed server's own kind: loopback (and http there) when the user typed
 *   one on this machine, the private network when they typed a private
 *   address. A link-local address, cloud metadata's among them, never.
 *
 * NO REDIRECT IS FOLLOWED HERE: a 3xx comes back as it is. The MCP SDK
 * follows one only within the request's origin, and does so by calling this
 * again, so every hop is checked on its own.
 */

/** Where an account's MCP server is, and who named it. */
export interface AccountServer {
  mcpUrl: string;
  /** The user typed `mcpUrl` at `tenjin connect`. Absent: the router named it. */
  typed?: boolean;
}

/** One request: pinned to the address the check validated, or, on the typed
 *  server's own origin, with no `pinned`, its name resolved as usual. */
export type AccountTransport = (request: Request, pinned?: PinnedTarget) => Promise<Response>;

export interface AccountFetchDeps {
  /** Test seam; production sends on {@link pinnedHttp}, or `fetch` on the
   *  typed server's own origin. */
  transport?: AccountTransport;
  /** Resolver seam, as the paid call's. */
  destination?: DestinationOptions;
}

/** Statuses whose response has no body, which a `Response` refuses one for. */
const NO_BODY = new Set([204, 205, 304]);

/** A node response as `fetch` would hand it back: every header value, and the
 *  body as it streams. */
export function responseOf(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const each of Array.isArray(value) ? value : value !== undefined ? [value] : []) {
      headers.append(name, each);
    }
  }
  const status = res.statusCode ?? 0;
  const empty = NO_BODY.has(status) || method === 'HEAD';
  if (empty) res.resume();
  return new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    statusText: res.statusMessage ?? '',
    headers,
  });
}

/** `node:https` sends no user agent of its own: the CLI's, as a poll's, where
 *  the caller set none. A network failure rejects as `fetch`'s does, a
 *  `TypeError`, which the SDK's discovery reads as a URL to move past. */
const send: AccountTransport = async (request, pinned) => {
  const headers = { 'user-agent': composeUserAgent(), ...Object.fromEntries(request.headers) };
  const body = request.body !== null ? new Uint8Array(await request.arrayBuffer()) : undefined;
  if (pinned === undefined) {
    return fetch(request.url, {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: 'manual',
      ...(body !== undefined ? { body } : {}),
    });
  }
  const res = await pinnedHttp(
    pinned,
    { method: request.method, headers, ...(body !== undefined ? { body } : {}) },
    request.signal,
  ).catch((err: unknown) => {
    if (request.signal.aborted) throw err;
    throw new TypeError(err instanceof Error ? err.message : String(err), { cause: err });
  });
  return responseOf(res, request.method);
};

/** How a refused host is named, by what the account may reach. */
const REACH: Record<AddressClass, string> = {
  public: 'a public HTTPS address',
  loopback: 'a public HTTPS address or one on this machine',
  private: 'a public HTTPS address or one on your network',
};

/** The typed server's origin, where it is one `isAccountUrl` takes: https, or
 *  http on this machine. Anything else is checked as a router's would be. */
function typedOrigin(server: AccountServer): URL | undefined {
  if (server.typed !== true || !URL.canParse(server.mcpUrl)) return undefined;
  const url = new URL(server.mcpUrl);
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
    ? url
    : undefined;
}

/** The fetch every request for the account at `server` goes out on. */
export function accountFetch(server: AccountServer, deps: AccountFetchDeps = {}): typeof fetch {
  const own = typedOrigin(server);
  const allow: AddressClass = own !== undefined ? addressClassOf(own.hostname) : 'public';
  const transport = deps.transport ?? send;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (own !== undefined && new URL(request.url).origin === own.origin) return transport(request);
    let pinned: PinnedTarget;
    try {
      pinned = await resolvePublicDestination(request.url, { ...deps.destination, allow });
    } catch (err) {
      // As a poll's (`jobs.ts`): a name that did not resolve is the
      // network's failure; anything else is the address refused.
      const unresolved =
        err instanceof CliError &&
        (err.details as { cause?: unknown } | undefined)?.cause !== undefined;
      const host = new URL(request.url).host;
      throw new Error(
        unresolved ? `${host} could not be resolved` : `${host} is not ${REACH[allow]}`,
        { cause: err },
      );
    }
    return transport(request, pinned);
  }) as typeof fetch;
}
