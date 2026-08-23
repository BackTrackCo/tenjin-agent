import { CliError } from './errors';
import { composeUserAgent } from './client-meta';

/**
 * The single JSON client the whole CLI grows on: `doctor` uses it in B1, `search`
 * reuses it in B2. It never throws on a transport/protocol failure — it returns a
 * discriminated result so callers decide how each failure class maps to a check
 * or an error. `fetchImpl` is injectable so tests never touch the network.
 */
export interface FetchJsonOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs: number;
  /** Override global fetch (tests inject a stub returning canned Responses). */
  fetchImpl?: typeof fetch;
  /** Optional request headers, merged onto the User-Agent this module always sends. */
  headers?: Record<string, string>;
  /** The team shelf's bypass secret and its origin; see {@link ShelfBypass}. */
  bypass?: ShelfBypass;
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
}

/**
 * The team shelf's Vercel "Protection Bypass for Automation" header.
 *
 * A door key for a protected preview deployment, not a credential of anyone's:
 * it gets a request past Deployment Protection and authenticates nobody. It is
 * NOT in {@link CREDENTIAL_HEADERS} for that reason — it signs nothing, so a
 * redirect carrying it cannot be replayed into a signature — but it is still a
 * secret, so where it may go is decided here and nowhere else.
 */
export const SHELF_BYPASS_HEADER = 'x-vercel-protection-bypass';

/**
 * A bypass secret and the origin it belongs to.
 *
 * THE ORIGIN IS PART OF THE VALUE, and that is the whole design. The CLI talks
 * to two shelves in team mode — the team's own deployment and the public
 * marketplace — and a caller that decides "this request is to the team shelf, so
 * attach the key" is a caller that eventually gets it wrong once. So callers
 * pass the pair and this transport does the compare: the header is attached from
 * the REQUEST URL, so a request to any other host cannot carry it, whatever the
 * call site believed.
 */
export interface ShelfBypass {
  /** `URL.origin` of the shelf the secret opens (the configured `baseUrl`). */
  origin: string;
  secret: string;
}

/** The bypass header for `url`, or nothing. Exported for the hook-script mirror
 *  test, which runs the generated copy of this rule against this one. */
export function shelfBypassHeaders(
  url: string,
  bypass: ShelfBypass | undefined,
): Record<string, string> {
  if (bypass === undefined || bypass.secret.length === 0) return {};
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return {};
  }
  if (origin !== bypass.origin) return {};
  return { [SHELF_BYPASS_HEADER]: bypass.secret };
}

/**
 * The one place the identity is written for anything that can import it; both
 * transports funnel their Headers through it, so a third entry point on this
 * side cannot ship without it. The generated hook scripts are the one request
 * path that cannot reach here, and they carry their own mirrored composer
 * (`lib/hook-scripts.ts`) rather than an exemption. `.set` on a Headers
 * object is what makes this total: a caller header spelled `User-Agent` in any
 * case lands in the same slot and is overwritten, never duplicated, so a
 * call-specific header cannot erase the composed field or add a second one.
 */
function applyUserAgent(headers: Headers, callerUserAgent?: string): Headers {
  headers.set('user-agent', composeUserAgent({ caller: callerUserAgent }));
  return headers;
}

/** The same write for `fetchJson`'s plain-object headers; Headers.entries() is lowercase-keyed. */
function withUserAgent(
  callerHeaders?: Record<string, string>,
  callerUserAgent?: string,
): Record<string, string> {
  return Object.fromEntries(
    applyUserAgent(new Headers(callerHeaders ?? {}), callerUserAgent).entries(),
  );
}

/** A successful 2xx whose body parsed as JSON. */
export interface FetchJsonSuccess {
  ok: true;
  status: number;
  json: unknown;
  /** The server's `x-request-id`, when it sent one — useful in error reports. */
  requestId?: string;
}

/**
 * A failed request, tagged by class so the caller maps it deliberately:
 * `network`/`timeout` (never reached the server or no answer), `http` (a non-2xx
 * status), `invalid-json` (2xx but the body was not JSON).
 */
export interface FetchJsonFailure {
  ok: false;
  kind: 'network' | 'timeout' | 'http' | 'invalid-json' | 'blocked-redirect';
  status?: number;
  requestId?: string;
  message: string;
}

/**
 * Header names that carry wallet-signed material.
 *
 * A request bearing any of these must NEVER follow a redirect. `resource-ref`
 * pins the invariant — "nothing signed may leave for a host the user did not
 * configure" — but `assertOnBaseOrigin` only checks the URL the caller asked
 * for, and `fetch`'s default `redirect: 'follow'` re-sends request headers
 * verbatim to the new host (Node strips only `Authorization`). A 3xx anywhere on
 * the configured origin would therefore hand a signature BOUND TO THE REAL
 * DOMAIN to whoever `Location` points at, replayable against it for the
 * signature's lifetime.
 *
 * Detected by header NAME rather than by a caller-supplied "this is signed" flag
 * so the protection cannot be forgotten at a call site: attaching the credential
 * is what arms it. Matched case-insensitively. Kept as literals so the base
 * transport keeps its single dependency; `http.test.ts` pins them against the
 * real constants in `lib/siwx` and the x402 payment headers.
 *
 * All three wallet-signed families this CLI sends are here: the SIWX auth
 * header, the x402 payment header (`payment-signature` for x402 v2, plus
 * `x-payment`, the v1 spelling `@x402/core` can emit, as drift insurance even
 * though `read-client` pins v2), and `tenjin-session-delegation` — a REUSABLE
 * session-lifetime SIWX signature `session-key` attaches to every session-signed
 * write, which makes it the most replayable credential of the set. The RFC 9421
 * `Signature`/`Signature-Input` pair riding alongside it is deliberately absent:
 * it covers method, URL, and body digest, so it is not usefully replayable at
 * another host.
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

export type FetchJsonResult = FetchJsonSuccess | FetchJsonFailure;

export async function fetchJson(url: string, opts: FetchJsonOptions): Promise<FetchJsonResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  // The timer stays armed until the body is fully consumed (cleared in the outer
  // finally), so a server that sends headers then stalls the body still trips the
  // deadline instead of hanging forever on res.json().
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        signal: controller.signal,
        headers: withUserAgent(
          { ...opts.headers, ...shelfBypassHeaders(url, opts.bypass) },
          opts.callerUserAgent,
        ),
      });
    } catch (err) {
      // A timeout is a network failure the AbortController induced; distinguish it
      // from an organic one so the caller can say "timed out" rather than a raw
      // AbortError message.
      return timedOut
        ? timeoutFailure(url, opts.timeoutMs)
        : { ok: false, kind: 'network', message: `Request to ${url} failed: ${errorMessage(err)}` };
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;

    if (!res.ok) {
      return {
        ok: false,
        kind: 'http',
        status: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        message: `Request to ${url} failed with status ${res.status}`,
      };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      // The body read can fail three ways. A timeout wins first: the abort fires
      // synchronously with `timedOut`, so any abort-induced rejection here is our
      // deadline. Otherwise a SyntaxError is a genuine parse failure (invalid
      // JSON); anything else is a transport failure mid-body (network).
      if (timedOut) return timeoutFailure(url, opts.timeoutMs);
      if (err instanceof SyntaxError) {
        return {
          ok: false,
          kind: 'invalid-json',
          status: res.status,
          ...(requestId !== undefined ? { requestId } : {}),
          message: `Response from ${url} was not valid JSON`,
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

    return {
      ok: true,
      status: res.status,
      json,
      ...(requestId !== undefined ? { requestId } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
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
 * body for ANY status. Unlike fetchJson (2xx-only), the B2 read/pay flow needs
 * the body on a 402 (the leak-safe preview) and a 409 (the owned-re-pay gate),
 * and search/outcome need a 4xx validation envelope. A transport/timeout failure
 * still returns the discriminated FetchJsonFailure so callers map it uniformly.
 */
export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  timeoutMs: number;
  headers?: Record<string, string>;
  /** The team shelf's bypass secret and its origin; see {@link ShelfBypass}. */
  bypass?: ShelfBypass;
  /** INTERNAL; see `FetchJsonOptions.callerUserAgent`. */
  callerUserAgent?: string;
  /** A JSON body (POST); serialized with a content-type header set automatically. */
  jsonBody?: unknown;
  fetchImpl?: typeof fetch;
  /**
   * Refuse redirects even when the request carries no signed header. For a
   * caller whose response becomes a durable local artifact (`fetchRead`: the
   * 200 is written to the library as an entitlement record under the
   * server-chosen id/slug), following a cross-origin redirect would let
   * another host's bytes be recorded as if the configured origin served them.
   * Off by default so search/outcome/publish/doctor keep normal transport.
   */
  blockRedirects?: boolean;
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
    // The bypass rides in with the caller's headers rather than being set after
    // them, so a caller cannot spell it a second way and win the slot.
    const merged = new Headers({ ...opts.headers, ...shelfBypassHeaders(url, opts.bypass) });
    if (opts.jsonBody !== undefined) {
      body = JSON.stringify(opts.jsonBody);
      merged.set('content-type', 'application/json');
    }
    const wantsAccept = opts.method === 'POST' || opts.method === 'PUT' || body !== undefined;
    if (wantsAccept && !merged.has('accept')) merged.set('accept', 'application/json');
    // An `accept`/`content-type` set here wins the slot regardless of how a
    // caller cased its own copy.
    const headers = Object.fromEntries(applyUserAgent(merged, opts.callerUserAgent).entries());

    // Signed requests opt out of redirect following entirely; see CREDENTIAL_HEADERS.
    // A caller can also pin an unsigned request (blockRedirects) when the
    // response it gets back becomes a durable local record.
    const signed = carriesSignedMaterial(headers);
    return { ok: true, headers, body, signed, pinned: signed || opts.blockRedirects === true };
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

  try {
    const prepared = prepareRequest(url, opts);
    if (!prepared.ok) return prepared;
    const { headers, body, signed, pinned } = prepared;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
        ...(pinned ? { redirect: 'manual' as const } : {}),
      });
    } catch (err) {
      return timedOut
        ? timeoutFailure(url, opts.timeoutMs)
        : { ok: false, kind: 'network', message: `Request to ${url} failed: ${errorMessage(err)}` };
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
    try {
      text = await res.text();
    } catch (err) {
      if (timedOut) return timeoutFailure(url, opts.timeoutMs);
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
 * NETWORK_ERROR, an `http` status (server reachable but errored — commonly 5xx)
 * is API_UNREACHABLE, and a 2xx that failed to parse when JSON was required is a
 * CONTRACT_MISMATCH. Callers that need a check-specific code (doctor) build their
 * own CliError; this is the default B2's passthrough leans on.
 */
export function fetchFailureToCliError(
  failure: FetchJsonFailure,
  opts: FailureToCliErrorOptions = {},
): CliError {
  const code =
    failure.kind === 'network' || failure.kind === 'timeout'
      ? 'NETWORK_ERROR'
      : failure.kind === 'invalid-json'
        ? 'CONTRACT_MISMATCH'
        : 'API_UNREACHABLE';
  return new CliError(code, failure.message, {
    ...(opts.fix !== undefined ? { fix: opts.fix } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
