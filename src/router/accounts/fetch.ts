import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { composeUserAgent } from '../../lib/client-meta';
import { resolvePublicDestination, type DestinationOptions } from '../../lib/destination';
import { CliError } from '../../lib/errors';
import { pinnedHttps, type PinnedTarget } from '../paid';

/**
 * EVERY REQUEST TO A CONNECTED ACCOUNT'S HOSTS, through one fetch: the MCP
 * server's first 401 and the sign-in's discovery, registration, token and
 * revocation requests (`oauth.ts`), a refresh (`credential.ts`), and the MCP
 * session itself (`client.ts`). The server's address comes from the router's
 * identities read or from the user, and the sign-in's from that server's own
 * metadata, so each is held to what a paid call's destination is
 * (`lib/destination.ts`): public HTTPS, every address the name resolves to
 * public, and the socket connected to the one address that was checked
 * ({@link pinnedHttps}), so a name that turns private between the check and
 * the connect gets nothing. TLS still verifies the certificate against the
 * URL's own host name.
 *
 * NO REDIRECT IS FOLLOWED HERE: a 3xx comes back as it is. The MCP SDK
 * follows one only within the request's origin, and does so by calling this
 * again, so every hop is checked and pinned on its own.
 */

/** One request, connected to the address that was checked. */
export type AccountTransport = (target: PinnedTarget, request: Request) => Promise<Response>;

export interface AccountFetchDeps {
  /** Test seam; production sends on {@link pinnedHttps}. */
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
const sendPinned: AccountTransport = async (target, request) => {
  const body = request.body !== null ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const res = await pinnedHttps(
    target,
    {
      method: request.method,
      headers: { 'user-agent': composeUserAgent(), ...Object.fromEntries(request.headers) },
      ...(body !== undefined ? { body } : {}),
    },
    request.signal,
  ).catch((err: unknown) => {
    if (request.signal.aborted) throw err;
    throw new TypeError(err instanceof Error ? err.message : String(err), { cause: err });
  });
  return responseOf(res, request.method);
};

/** The account fetch with its seams. */
export function accountFetchWith(deps: AccountFetchDeps = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    let target: PinnedTarget;
    try {
      target = await resolvePublicDestination(request.url, deps.destination ?? {});
    } catch (err) {
      // As a poll's (`jobs.ts`): a name that did not resolve is the
      // network's failure; anything else is the address refused.
      const unresolved =
        err instanceof CliError &&
        (err.details as { cause?: unknown } | undefined)?.cause !== undefined;
      const host = new URL(request.url).host;
      throw new Error(
        unresolved ? `${host} could not be resolved` : `${host} is not a public HTTPS address`,
        { cause: err },
      );
    }
    return (deps.transport ?? sendPinned)(target, request);
  }) as typeof fetch;
}

/** The fetch every account request goes out on. */
export const accountFetch: typeof fetch = accountFetchWith();
