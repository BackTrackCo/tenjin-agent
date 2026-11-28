import type { IncomingMessage } from 'node:http';
import { resolvePublicDestination, type DestinationOptions } from '../lib/destination';
import { pinnedHttp, type PinnedTarget } from './paid';

/**
 * A `fetch` THAT CONNECTS TO THE ADDRESS IT CHECKED. Every request to a provider's own host goes
 * through `resolvePublicDestination` (public HTTPS on 443 only, every answer in reach), and the
 * socket is opened to the one address that passed, so a host that answers publicly to the check
 * and privately a moment later gets nothing (`pinnedHttp`). Plain `fetch` resolves the name again
 * on its own. No redirect is followed: the caller sees the 3xx, as `pinnedHttp` gives it.
 */
export type PinnedFetchOptions = {
  destination?: DestinationOptions;
  /** Test seam; production connects with {@link pinnedHttp}. */
  transport?: (
    target: PinnedTarget,
    request: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
    signal: AbortSignal,
  ) => Promise<IncomingMessage>;
  /** The longest reply taken, in bytes. A chat completion is a few tens of kilobytes. */
  maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const NO_BODY = new Set([204, 205, 304]);

export function pinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const send = options.transport ?? pinnedHttp;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const raw = request ? request.url : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(request?.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    let body: string | Uint8Array | undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof Uint8Array) body = init.body;
      else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
      else throw new TypeError('A provider request body is a string or bytes.');
    } else if (request && method !== 'GET' && method !== 'HEAD') {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      if (bytes.byteLength > 0) body = bytes;
    }
    const signal = init?.signal ?? request?.signal ?? new AbortController().signal;
    // The check comes first: a refused destination is never connected to.
    const target = await resolvePublicDestination(raw, options.destination ?? {});
    const res = await send(
      target,
      { method, headers: Object.fromEntries(headers), ...(body !== undefined ? { body } : {}) },
      signal,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      size += (chunk as Buffer).byteLength;
      if (size > maxBytes) {
        res.destroy();
        throw new Error('The provider reply is too long.');
      }
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers))
      if (Array.isArray(value)) for (const one of value) out.append(name, one);
      else if (value !== undefined) out.set(name, value);
    const status = res.statusCode ?? 0;
    return new Response(NO_BODY.has(status) || method === 'HEAD' ? null : Buffer.concat(chunks), {
      status,
      headers: out,
    });
  }) as typeof fetch;
}
