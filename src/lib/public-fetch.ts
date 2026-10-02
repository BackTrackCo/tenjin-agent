import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { publicOnlyLookup, type DestinationOptions } from './destination';

/**
 * THE PAID LEG'S TRANSPORT: `fetch`'s shape over `node:https`, every socket
 * connected through {@link publicOnlyLookup}. `fetch` takes a lookup only
 * through an undici dispatcher, and Node bundles undici without exporting it;
 * `node:https` takes one as a plain option, the way the router's media download
 * already connects (`router/paid.ts`). So each connection resolves the
 * provider's name once, refuses it unless every answer is public, and goes to
 * an answer that passed: a host that rebinds between `runPay`'s preflight and
 * the probe, or between the probe and the paid retry, reaches nothing. TLS
 * still verifies the certificate against the URL's own host name, and the
 * `Host` header is that name.
 *
 * It does what `httpRequest` asks of a fetch and no more: a string body, the
 * status, headers and body stream back, an abort signal, and the compression
 * `fetch` would have negotiated and undone. It NEVER follows a redirect: a 3xx
 * comes back as itself, which is what every paid leg asks for
 * (`redirect: 'manual'`) and what `httpRequest` then refuses by name.
 */
export function publicOnlyFetch(options: DestinationOptions = {}): typeof fetch {
  return lookupFetch(publicOnlyLookup(options));
}

/**
 * IS NODE SENDING THROUGH A PROXY? Node routes `fetch` through `HTTP(S)_PROXY`
 * only when told to (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`), and then the
 * proxy resolves the provider's name, not this process, so there is no
 * connection here to check. The paid leg keeps that configured path rather than
 * silently going around it; docs/safety-model.md names it as a bound.
 */
export function envProxyInUse(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  const on =
    env.NODE_USE_ENV_PROXY === '1' ||
    [...execArgv, ...(env.NODE_OPTIONS ?? '').split(/\s+/)].includes('--use-env-proxy');
  return (
    on &&
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
      (name) => (env[name] ?? '') !== '',
    )
  );
}

/**
 * `fetch` over `request`, each socket connected through `lookup`. `request` is
 * `node:https` in production; a test passes `node:http` to reach a local
 * server without a certificate.
 */
export function lookupFetch(
  lookup: LookupFunction,
  request: typeof httpsRequest = httpsRequest,
): typeof fetch {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      if (input instanceof Request || (init.body != null && typeof init.body !== 'string')) {
        reject(new TypeError('This transport sends a URL, with a string body or none.'));
        return;
      }
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (!headers.has('accept')) headers.set('accept', '*/*');
      if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
      const body = init.body ?? undefined;
      if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
      const req = request(
        input,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          lookup,
          // A connection of its own, never one pooled by a request that did not
          // come through `lookup`.
          agent: false,
          ...(init.signal != null ? { signal: init.signal } : {}),
        },
        (res) => {
          // Inside an event handler a throw would take the process down, so a
          // response `Response` will not take is this request's failure.
          try {
            resolve(toResponse(res, method));
          } catch (err) {
            res.destroy();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
      req.on('error', reject);
      req.end(body);
    });
}

/** Statuses a `Response` may not give a body. */
const NULL_BODY = new Set([204, 205, 304]);

function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
  }
  const init = { status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers };
  if (NULL_BODY.has(init.status) || method === 'HEAD') {
    res.resume();
    return new Response(null, init);
  }
  return new Response(Readable.toWeb(decoded(res)) as unknown as ReadableStream<Uint8Array>, init);
}

/** Undo the one content coding `fetch` would have undone; anything else
 *  passes through as it was sent. */
function decoded(res: IncomingMessage): Readable {
  const coding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder =
    coding === 'gzip' || coding === 'x-gzip'
      ? createGunzip()
      : coding === 'deflate'
        ? createInflate()
        : coding === 'br'
          ? createBrotliDecompress()
          : null;
  return decoder === null ? res : pipeline(res, decoder, () => undefined);
}
