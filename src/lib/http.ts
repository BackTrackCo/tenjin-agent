import { CliError } from './errors';
import { composeUserAgent } from './client-meta';

/**
 * Vercel's "Protection Bypass for Automation" header: a door key to someone's
 * protected deployment. This client never sets it, and neither an operator's
 * `-H` nor a spec may (see {@link isReservedRequestHeader}): a request that
 * carried one would hand the key to whatever host it went to.
 */
const PROTECTION_BYPASS_HEADER = 'x-vercel-protection-bypass';

/** The anonymous install id: a random UUID minted once per data dir. */
export const INSTALL_ID_HEADER = 'tenjin-install-id';

/**
 * Who is using the router, for Tenjin's own request telemetry: an anonymous
 * install id, random and tied to nothing but the data dir.
 *
 * The transport decides where it goes, from the REQUEST URL, so a call site
 * cannot send it to a provider by believing it is talking to Tenjin. `pay` runs over this transport
 * to third-party sellers, and none of them gets the header.
 *
 * Process-wide rather than a per-call option because it is not a per-call
 * decision: every request to Tenjin carries it, and threading it through forty
 * call sites is forty chances to forget one. Set only by the process entry (the
 * CLI's `index.ts`), so an in-process test that never sets it sends exactly
 * what it always did.
 *
 * Redirects are left to the request's usual transport: an unpinned request
 * follows them as `fetch` does, headers and all. Tenjin's origins redirect only
 * to Tenjin's own hosts, and the id is not a credential, so it is not worth the
 * redirect pin signed headers get.
 */
export interface TenjinIdentity {
  /** The origins that are Tenjin's own for this process. */
  origins: () => Promise<readonly string[]>;
  /** The install id; absent when it could not be read or created. */
  installId: () => Promise<string | undefined>;
}

let tenjinIdentity: TenjinIdentity | undefined;

export function setTenjinIdentity(identity: TenjinIdentity | undefined): void {
  tenjinIdentity = identity;
}

/**
 * The telemetry headers for `url`, or nothing. NEVER THROWS: a data dir that
 * cannot be read costs the request its telemetry and nothing else.
 */
export async function tenjinIdentityHeaders(url: string): Promise<Record<string, string>> {
  const identity = tenjinIdentity;
  if (identity === undefined) return {};
  try {
    if (!(await identity.origins()).includes(new URL(url).origin)) return {};
    const id = await identity.installId();
    return id !== undefined ? { [INSTALL_ID_HEADER]: id } : {};
  } catch {
    return {};
  }
}

/**
 * The one place the identity is written for anything that can import it; the
 * transport funnels its Headers through it, so a second entry point on this
 * side cannot ship without it. `.set` on a Headers
 * object is what makes this total: a caller header spelled `User-Agent` in any
 * case lands in the same slot and is overwritten, never duplicated, so a
 * call-specific header cannot erase the composed field or add a second one.
 */
function applyUserAgent(headers: Headers, callerUserAgent?: string): Headers {
  headers.set('user-agent', composeUserAgent({ caller: callerUserAgent }));
  return headers;
}

/**
 * A failed request, tagged by class so the caller maps it deliberately:
 * `network`/`timeout` (never reached the server or no answer), `blocked-redirect`
 * (a 3xx a pinned request may not follow), `oversized-header` (a response
 * header block too large to read).
 */
export interface FetchJsonFailure {
  ok: false;
  kind: 'network' | 'timeout' | 'blocked-redirect' | 'oversized-header';
  status?: number;
  requestId?: string;
  message: string;
  /**
   * On `network`: the layer the error chain names, when it names one. The
   * origin never answered, so a caller that blames it (or its base URL) gives
   * the wrong fix. See {@link transportFailure}.
   */
  transport?: TransportFailure;
  /**
   * On a `timeout` that came after the response headers did (`httpRequest`
   * only): a case-insensitive lookup over them. A seller can name where a long
   * job's result will be with its first byte, and only the body ran out of time.
   */
  header?: (name: string) => string | undefined;
}

/** Which layer refused a request that never reached the origin. */
export interface TransportFailure {
  layer: 'proxy' | 'dns' | 'tls' | 'connect';
  /** The socket's own error code, for every layer but `proxy`. */
  code?: string;
  /** What the proxy answered to `CONNECT`, for `proxy` only. */
  proxyStatus?: number;
}

/**
 * Header names that carry wallet-signed material.
 *
 * A request bearing any of these must NEVER follow a redirect: nothing signed
 * may leave for a host the request did not name, and `fetch`'s default
 * `redirect: 'follow'` re-sends request headers verbatim to the new host (Node
 * strips only `Authorization`). A 3xx anywhere on the signed origin would
 * therefore hand a signature BOUND TO THAT DOMAIN to whoever `Location` points
 * at, replayable against it for the signature's lifetime.
 *
 * Detected by header NAME rather than by a caller-supplied "this is signed" flag
 * so the protection cannot be forgotten at a call site: attaching the credential
 * is what arms it. Matched case-insensitively. Kept as literals so the base
 * transport keeps its single dependency; `http.test.ts` pins them against the
 * real constants in `lib/siwx` and the x402 payment headers.
 *
 * Both wallet-signed families this CLI sends are here: the SIWX auth header,
 * and the x402 payment header (`payment-signature` for x402 v2, plus
 * `x-payment`, the v1 spelling `@x402/core` can emit, as drift insurance).
 * `tenjin-session-delegation`, the reusable session-lifetime SIWX signature an
 * earlier release attached to shelf writes, stays on the list: this client no
 * longer sends it, and refusing to let a caller send it costs nothing.
 */
const CREDENTIAL_HEADERS = new Set([
  'sign-in-with-x',
  'payment-signature',
  'x-payment',
  'tenjin-session-delegation',
]);

function carriesSignedMaterial(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => CREDENTIAL_HEADERS.has(name.toLowerCase()));
}

/**
 * A request header name an operator may not set: the wallet-signed material
 * above, a deployment-protection bypass key, this install's identity, and the
 * x402 payment namespace. Kept beside the set so the two cannot drift.
 */
export function isReservedRequestHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    CREDENTIAL_HEADERS.has(lowered) ||
    lowered === PROTECTION_BYPASS_HEADER ||
    lowered === INSTALL_ID_HEADER ||
    lowered.startsWith('payment-') ||
    lowered.startsWith('x-payment')
  );
}

/** One header name, as RFC 9110 spells a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Names the transport or the body encoding own. */
const TRANSPORT_HEADERS = new Set(['host', 'content-length', 'content-type', 'user-agent']);

/**
 * Why a request header someone else names (an operator's `-H`, a catalog
 * spec) cannot ride a paid request, or null when it can: `name` for a name
 * that is not a token or a value that is empty, `reserved` for a name this
 * client signs or sets itself or the transport owns, `value` for a value over
 * 1,024 characters or one that spans lines. `ownContentType` lets the caller
 * name `content-type`, for a body this client does not encode.
 */
export function requestHeaderProblem(
  name: string,
  value: string,
  ownContentType = false,
): 'name' | 'reserved' | 'value' | null {
  if (!HEADER_NAME.test(name) || value.length === 0) return 'name';
  const lowered = name.toLowerCase();
  const contentType = ownContentType && lowered === 'content-type';
  if (isReservedRequestHeader(lowered) || (TRANSPORT_HEADERS.has(lowered) && !contentType)) {
    return 'reserved';
  }
  if (value.length > 1_024 || /[\r\n]/.test(value)) return 'value';
  return null;
}

function timeoutFailure(url: string, timeoutMs: number): FetchJsonFailure {
  return {
    ok: false,
    kind: 'timeout',
    message: `Request to ${url} timed out after ${timeoutMs}ms`,
  };
}

/**
 * A full HTTP round trip that surfaces the STATUS, headers, and best-effort JSON
 * body for ANY status: the pay flow needs the body on a 402, and the router's
 * calls need a 4xx validation envelope. It never throws on a transport or
 * protocol failure: it returns the discriminated FetchJsonFailure so callers
 * map each class uniformly. `fetchImpl` is injectable so tests never touch the
 * network.
 */
export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  timeoutMs: number;
  headers?: Record<string, string>;
  /**
   * INTERNAL. A caller's own product sequence, composed BEHIND the CLI's
   * identity (see `composeUserAgent`). The package ships a `bin` and no
   * `exports` map, so this is not a supported seam for code outside this repo:
   * the documented handoff is the `TENJIN_CALLER_USER_AGENT` environment
   * variable, which is what a subprocess launcher sets and what this falls back
   * to. Kept as an option so an in-repo caller can pass a value the environment
   * does not carry.
   */
  callerUserAgent?: string;
  /** A JSON body (POST); serialized with a content-type header set automatically. */
  jsonBody?: unknown;
  /**
   * A body the CALLER already encoded, sent byte for byte with no content-type
   * of this transport's choosing: the router's provider leg is handed a request
   * the server built, and re-encoding it would make the bytes signed for and
   * the bytes sent two different things. The caller's own `headers` carry the
   * content type. Ignored when `jsonBody` is set.
   */
  rawBody?: string;
  fetchImpl?: typeof fetch;
  /**
   * A caller's own abort, combined with (never replacing) `timeoutMs`. The loop's
   * legs pass the fire's signal here so a harness that closed its socket stops the
   * request in flight; a caller with no such signal is unchanged.
   */
  signal?: AbortSignal;
  /**
   * Refuse redirects even when the request carries no signed header. For a
   * caller whose response becomes a durable local artifact, following a
   * cross-origin redirect would let another host's bytes be recorded as if the
   * origin asked for served them. Off by default, so other requests keep normal
   * transport.
   */
  blockRedirects?: boolean;
  /**
   * Keep a binary body as bytes. A sound, an image or any other non-text
   * payload decoded as text is corrupted, so with this set a response whose
   * content type is not text ({@link isBinaryContentType}) comes back with
   * `bytes` and an empty `text`. The router's provider leg sets it; every other
   * caller reads text as before.
   */
  binaryBody?: boolean;
  /** The cap on such a body; over it the response is a failure, never a
   *  buffer that grows without bound. Defaults to {@link MAX_BINARY_BODY_BYTES}. */
  maxBinaryBytes?: number;
  /**
   * Send no install id, and mint none. For a request that checks the network
   * rather than uses Tenjin (the reachability probe), so it never counts as an
   * install in request telemetry.
   */
  anonymous?: boolean;
}

/** The same cap the router's linked-media download uses. */
export const MAX_BINARY_BODY_BYTES = 200 * 1024 * 1024;

/** A body cap as a person reads it: whole MB, or bytes under one. */
function capText(bytes: number): string {
  return bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${bytes}-byte`;
}

/**
 * The body's bytes, read chunk by chunk and abandoned the moment they pass
 * `max`; null over the cap. A declared length over it is refused unread.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A content type whose body is not text: anything that is not `text/*` and
 * not a JSON, XML, JavaScript, YAML or form type. An absent header is text, as
 * it always was here.
 */
export function isBinaryContentType(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.length === 0) return false;
  if (type.startsWith('text/')) return false;
  return !/(?:json|xml|javascript|ecmascript|yaml|x-www-form-urlencoded)/.test(type);
}

export interface HttpResponse {
  ok: true;
  status: number;
  /** Case-insensitive header lookup over the response. */
  header(name: string): string | undefined;
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  json: unknown;
  /** The raw body text; what a non-JSON endpoint actually said (`pay` delivers it). */
  text: string;
  /** The body's bytes, only for a binary body read with `binaryBody`; `text`
   *  is then empty. */
  bytes?: Uint8Array;
  requestId?: string;
}

export type HttpResult = HttpResponse | FetchJsonFailure;

/** The wire form of one request: what to send, and whether it may follow a redirect. */
interface PreparedRequest {
  ok: true;
  headers: Record<string, string>;
  body: string | undefined;
  signed: boolean;
  pinned: boolean;
}

/**
 * Assemble the request and DERIVE its redirect decision from the headers that
 * were actually built, in one place and one pass. The redirect flags are
 * returned rather than assigned, so they have no value until the headers do:
 * there is no state in which `pinned` is readable but not yet computed, which
 * is what would let a signed request follow a 3xx to another host. Anything
 * that refuses here (`new Headers` throws on a malformed caller header) becomes
 * the same discriminated failure a dead socket does, because this transport
 * documents a returned failure for every refusal, not an exception.
 */
function prepareRequest(url: string, opts: HttpRequestOptions): PreparedRequest | FetchJsonFailure {
  try {
    let body: string | undefined;
    const merged = new Headers(opts.headers ?? {});
    if (opts.jsonBody !== undefined) {
      body = JSON.stringify(opts.jsonBody);
      merged.set('content-type', 'application/json');
    } else if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    }
    const wantsAccept =
      opts.method === 'POST' ||
      opts.method === 'PUT' ||
      opts.method === 'PATCH' ||
      body !== undefined;
    if (wantsAccept && !merged.has('accept')) merged.set('accept', 'application/json');
    // An `accept`/`content-type` set here wins the slot regardless of how a
    // caller cased its own copy.
    const headers = Object.fromEntries(applyUserAgent(merged, opts.callerUserAgent).entries());

    // Signed requests opt out of redirect following entirely; see CREDENTIAL_HEADERS.
    // A caller can also pin an unsigned request (blockRedirects) when the
    // response it gets back becomes a durable local record.
    const signed = carriesSignedMaterial(headers);
    return {
      ok: true,
      headers,
      body,
      signed,
      pinned: signed || opts.blockRedirects === true,
    };
  } catch (err) {
    return {
      ok: false,
      kind: 'network',
      message: `Request to ${url} failed: ${errorMessage(err)}`,
    };
  }
}

export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  // The caller's abort is combined with the timeout rather than chosen between:
  // whichever fires first ends the request, and `timedOut` still says which.
  const signal =
    opts.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, opts.signal]);

  try {
    const prepared = prepareRequest(url, opts);
    if (!prepared.ok) return prepared;
    const { headers, body, signed, pinned } = prepared;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers:
          opts.anonymous === true ? headers : { ...headers, ...(await tenjinIdentityHeaders(url)) },
        body,
        signal,
        ...(pinned ? { redirect: 'manual' as const } : {}),
      });
    } catch (err) {
      if (timedOut) return timeoutFailure(url, opts.timeoutMs);
      if (isHeaderOverflow(err)) return oversizedHeaderFailure(url);
      const transport = transportFailure(err);
      return {
        ok: false,
        kind: 'network',
        message: `Request to ${url} failed: ${errorMessage(err)}`,
        ...(transport !== undefined ? { transport } : {}),
      };
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;

    // Fail CLOSED on a redirect the request was not allowed to follow. This
    // returns a failure rather than the 3xx response so no caller can mistake an
    // unfollowed redirect for a normal status and retry it by hand.
    if (pinned && res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        kind: 'blocked-redirect',
        status: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        message: signed
          ? `Request to ${url} was redirected (${res.status}) while carrying a signed header; ` +
            'refusing to follow it, because the signature is bound to the configured origin.'
          : `Request to ${url} was redirected (${res.status}); ` +
            'refusing to follow it, because the response must come from the configured origin.',
      };
    }
    // Read the raw text once; parse best-effort. A non-JSON body (empty 202, an
    // HTML error page) yields `undefined` rather than a thrown parse, because a
    // 402/409 caller keys off the STATUS and only some statuses carry JSON.
    let text: string;
    let bytes: Uint8Array | undefined;
    try {
      if (opts.binaryBody === true && isBinaryContentType(res.headers.get('content-type') ?? '')) {
        const read = await readCapped(res, opts.maxBinaryBytes ?? MAX_BINARY_BODY_BYTES);
        if (read === null) {
          return {
            ok: false,
            kind: 'network',
            status: res.status,
            ...(requestId !== undefined ? { requestId } : {}),
            message: `Request to ${url} returned a file over the ${capText(opts.maxBinaryBytes ?? MAX_BINARY_BODY_BYTES)} cap; it was not kept.`,
          };
        }
        bytes = read;
        text = '';
      } else {
        text = await res.text();
      }
    } catch (err) {
      if (timedOut) {
        return {
          ...timeoutFailure(url, opts.timeoutMs),
          header: (name) => res.headers.get(name) ?? undefined,
        };
      }
      return {
        ok: false,
        kind: 'network',
        status: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        message: `Request to ${url} failed while reading the response body: ${errorMessage(err)}`,
      };
    }
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      ok: true,
      status: res.status,
      header: (name) => res.headers.get(name) ?? undefined,
      json,
      text,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FailureToCliErrorOptions {
  fix?: string;
  details?: unknown;
}

/**
 * Normalize a fetch failure into the CLI error contract: network/timeout are a
 * NETWORK_ERROR, an oversized header block is CHALLENGE_TOO_LARGE, and a
 * blocked redirect is API_UNREACHABLE. Callers that need a check-specific code
 * build their own CliError; this is the default the rest lean on.
 */
export function fetchFailureToCliError(
  failure: FetchJsonFailure,
  opts: FailureToCliErrorOptions = {},
): CliError {
  const code =
    failure.kind === 'network' || failure.kind === 'timeout'
      ? 'NETWORK_ERROR'
      : failure.kind === 'oversized-header'
        ? 'CHALLENGE_TOO_LARGE'
        : 'API_UNREACHABLE';
  // The one failure with a remedy nobody can apply from inside the process, so
  // it names the operator's knob rather than suggesting a retry.
  // The knob, with no claim about payment: a caller that knows its leg passes
  // its own `fix` and says what happened to the money there.
  const fix =
    opts.fix ??
    (failure.kind === 'oversized-header'
      ? 'Raising `--max-http-header-size` on the node process that runs this CLI would let the header be read; that is an operator decision, not a default this build changes.'
      : undefined);
  return new CliError(code, failure.message, {
    ...(fix !== undefined ? { fix } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does this transport failure mean the response HEADERS were too big for this
 * process to read?
 *
 * Node caps them at 16 KiB unless `--max-http-header-size` says otherwise, and
 * an x402 challenge is a header: a seller that embeds its whole output schema
 * in one can exceed the cap on its own (AnyAPI's is 52 KB, measured
 * 2026-09-22). undici then aborts the request and the generic path reported
 * `fetch failed` with no status and nothing naming the cause, which reads as
 * "the endpoint is down" for a seller that is answering perfectly.
 *
 * The message is undici's, matched on its stable text and on the code it
 * attaches; the CAUSE is the one that carries either, so both are checked.
 */
function isHeaderOverflow(err: unknown): boolean {
  const seen = [err, (err as { cause?: unknown } | null)?.cause];
  return seen.some((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return false;
    const code = (candidate as { code?: unknown }).code;
    if (code === 'UND_ERR_HEADERS_OVERFLOW' || code === 'HPE_HEADER_OVERFLOW') return true;
    const message = (candidate as { message?: unknown }).message;
    return typeof message === 'string' && /headers overflow|header overflow/i.test(message);
  });
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TLS_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_)/;
/** undici's text when a proxy answers `CONNECT` with anything but 200. */
const PROXY_REFUSAL = /Proxy response \((\d{3})\)/;

/**
 * The layer a `fetch failed` came from, read down the `cause` chain. fetch
 * wraps the real error twice: a proxy refusing the tunnel is
 * `TypeError: fetch failed`, then `Request was cancelled.`, then undici's
 * `UND_ERR_ABORTED` with the proxy's status in its message (Node 24.18,
 * measured 2026-10-05). Undefined when no link names a layer.
 */
export function transportFailure(err: unknown): TransportFailure | undefined {
  let link: unknown = err;
  for (let depth = 0; depth < 5 && link !== null && typeof link === 'object'; depth += 1) {
    const { code, message, cause } = link as { code?: unknown; message?: unknown; cause?: unknown };
    const proxy = typeof message === 'string' ? PROXY_REFUSAL.exec(message) : null;
    if (proxy !== null) return { layer: 'proxy', proxyStatus: Number(proxy[1]) };
    if (typeof code === 'string') {
      if (DNS_CODES.has(code)) return { layer: 'dns', code };
      if (TLS_CODE.test(code)) return { layer: 'tls', code };
      if (CONNECT_CODES.has(code)) return { layer: 'connect', code };
    }
    link = cause;
  }
  return undefined;
}

/**
 * The named refusal for that case. NOT a `network` failure: nothing is wrong
 * with the connection, and a caller that retries gets the same 52 KB again.
 *
 * SAYS NOTHING ABOUT PAYMENT. This transport serves the unpaid probe and the
 * paid retry alike and cannot tell them apart, so a message asserting either
 * way is wrong on one of them: it read as "nothing was sent" on a leg where a
 * signed authorization had already left. The leg adds that sentence, because
 * the leg is what knows; see `runPay`.
 */
function oversizedHeaderFailure(url: string): FetchJsonFailure {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Keep the raw string; this is a diagnostic, not a destination.
  }
  return {
    ok: false,
    kind: 'oversized-header',
    message:
      `${origin} answered with a response header block larger than this process will read. ` +
      'An x402 challenge travels in a header, and a seller that embeds its whole output ' +
      'schema in one can exceed the limit, so the response could not be read.',
  };
}
