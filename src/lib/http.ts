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
 * NOT in {@link CREDENTIAL_HEADERS}, whose members are wallet-signed material a
 * redirect target could REPLAY — this one cannot be replayed into a signature.
 * It is still a secret, and DISCLOSING it is the whole harm: whoever holds it
 * walks into the team shelf. So it pins redirects exactly as a signed header
 * does (see {@link carriesBypassKey}), and where it may go is decided here and
 * nowhere else.
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
 * Whether the request being assembled actually carries the door key.
 *
 * A request that carries it MUST NOT follow a redirect. `fetch`'s default
 * `redirect: 'follow'` re-sends request headers verbatim to the new host (Node
 * strips only `Authorization`), so a single 3xx anywhere on the shelf origin —
 * the Vercel Authentication interstitial a rotated bypass secret gets, a domain
 * alias, a CDN rule — would hand the team shelf's key to whatever `Location`
 * names. Nothing else is needed to walk in afterwards, so the key never leaves
 * the origin it was paired with, not even one hop.
 *
 * Read off the BUILT headers rather than off `opts.bypass`, for the same reason
 * {@link CREDENTIAL_HEADERS} is matched by name: attaching the secret is what
 * arms the protection, so an off-origin request (which gets no header) keeps
 * ordinary transport and a call site cannot forget to ask for the pin.
 */
function carriesBypassKey(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === SHELF_BYPASS_HEADER);
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
  /**
   * On `invalid-json`, and on `http` when the status is 401/403: the response
   * looks like an access-protection or sign-in page rather than an API answer.
   * See {@link accessGateSignals} for what "looks like" means. Callers use it to
   * point at the missing credential instead of at the base URL, which is the one
   * setting that was already correct (#218).
   */
  gateSuspected?: boolean;
  /**
   * Present (true) only where the response left the host that was asked for:
   * `gateSuspected`'s STRONGER signal (the final URL's host differs), or, on
   * `blocked-redirect`, a `Location` that resolves to another host. An HTML
   * content-type alone proves a page came back, not who sent it, and a 3xx
   * alone proves only that the URL moved; leaving the host is what lets a
   * caller name access protection outright.
   */
  gateOffOrigin?: boolean;
}

/**
 * Does this response read as a protection page rather than as an API answer?
 *
 * Two independent signals, reported separately because they prove different
 * amounts (the caller's wording must not outrun the evidence):
 *
 * - an HTML content-type, because a Vercel Deployment Protection interstitial
 *   and every sign-in wall answer with a page;
 * - a final URL whose host is not the one asked for, because a gate that
 *   redirects to sign in lands the probe on another host and `fetch` follows it
 *   silently on the unpinned requests this function serves.
 *
 * Decided HERE because this transport is the only place holding the `Response`;
 * a caller re-deriving it from the failure message would be guessing. An
 * unreadable final URL is NOT suspicion: `res.url` is empty on a synthesized
 * Response, so only a host that reads AND differs counts.
 */
function accessGateSignals(
  requestedUrl: string,
  res: Response,
): { gateSuspected: boolean; gateOffOrigin?: true } {
  const html = /^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '');
  let offOrigin = false;
  if (res.url.length > 0) {
    try {
      offOrigin = new URL(requestedUrl).host !== new URL(res.url).host;
    } catch {
      offOrigin = false;
    }
  }
  return {
    gateSuspected: html || offOrigin,
    ...(offOrigin ? { gateOffOrigin: true as const } : {}),
  };
}

/**
 * Does an unfollowed 3xx point off the host that was asked for?
 *
 * The pinned branch never follows, so `res.url` is still the requested URL and
 * `Location` is the only evidence about where the hop went. That distinction
 * carries the whole verdict downstream: a gate's sign-in interstitial lands on
 * another host, while an `http://` base URL that 301s to https, or a host
 * normalising to its canonical name, does not, and reading either as a refused
 * credential blames the wrong setting. A relative target resolves against the
 * request, so it is same-host by construction; a missing or unparseable one is
 * NOT an off-host claim.
 */
function redirectLeavesHost(requestedUrl: string, location: string | null): boolean {
  if (location === null || location.length === 0) return false;
  try {
    return new URL(requestedUrl).host !== new URL(location, requestedUrl).host;
  } catch {
    return false;
  }
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
    // `new Headers` throws on a malformed caller header, so building them stays
    // inside the catch that turns any pre-flight refusal into the same
    // discriminated network failure a dead socket gets.
    let pinned = false;
    try {
      const headers = withUserAgent(
        { ...opts.headers, ...shelfBypassHeaders(url, opts.bypass) },
        opts.callerUserAgent,
      );
      // fetchJson sends no signed material — doctor's probes and the contract
      // checks are anonymous — so the door key is the one thing here worth
      // pinning, and it pins the same way it does in httpRequest.
      pinned = carriesBypassKey(headers);
      res = await doFetch(url, {
        signal: controller.signal,
        headers,
        ...(pinned ? { redirect: 'manual' as const } : {}),
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

    // Fail CLOSED, ahead of the ordinary non-2xx branch, so an unfollowed 3xx is
    // never reported as a plain HTTP status a caller might retry by hand.
    if (pinned && res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        kind: 'blocked-redirect',
        status: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        // Where it pointed, not that it pointed: only a hop that leaves the host
        // asked for is evidence about the key. Same-host 3xx happens to a base
        // URL that needs fixing, with a perfectly good key.
        ...(redirectLeavesHost(url, res.headers.get('location'))
          ? { gateOffOrigin: true as const }
          : {}),
        message:
          `Request to ${url} was redirected (${res.status}) while carrying the team shelf's ` +
          'bypass key; refusing to follow it, because the key opens only the configured origin.',
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        kind: 'http',
        status: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        // 401/403 is one of the three shapes deployment protection answers with
        // (200 HTML and a 30x interstitial are the others), so the gate signals
        // ride here too. Other statuses stay unmarked: a 404 or 500 HTML page is
        // an ordinary broken deployment, not a credential problem.
        ...(res.status === 401 || res.status === 403 ? accessGateSignals(url, res) : {}),
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
          ...accessGateSignals(url, res),
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
  bypassed: boolean;
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
    // So does a request carrying the team shelf's bypass key: it cannot be
    // replayed, but a 3xx would DISCLOSE it, and that is the whole harm (see
    // carriesBypassKey). A caller can also pin an unsigned, keyless request
    // (blockRedirects) when the response it gets back becomes a durable local record.
    const signed = carriesSignedMaterial(headers);
    const bypassed = carriesBypassKey(headers);
    return {
      ok: true,
      headers,
      body,
      signed,
      bypassed,
      pinned: signed || bypassed || opts.blockRedirects === true,
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

  try {
    const prepared = prepareRequest(url, opts);
    if (!prepared.ok) return prepared;
    const { headers, body, signed, bypassed, pinned } = prepared;

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
          : bypassed
            ? `Request to ${url} was redirected (${res.status}) while carrying the team shelf's ` +
              'bypass key; refusing to follow it, because the key opens only the configured origin.'
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
