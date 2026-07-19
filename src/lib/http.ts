import { CliError } from './errors';

/**
 * The single JSON client the whole CLI grows on: `doctor` uses it in B1, `lookup`
 * reuses it in B2. It never throws on a transport/protocol failure — it returns a
 * discriminated result so callers decide how each failure class maps to a check
 * or an error. `fetchImpl` is injectable so tests never touch the network.
 */
export interface FetchJsonOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs: number;
  /** Override global fetch (tests inject a stub returning canned Responses). */
  fetchImpl?: typeof fetch;
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
  kind: 'network' | 'timeout' | 'http' | 'invalid-json';
  status?: number;
  requestId?: string;
  message: string;
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
      res = await doFetch(url, { signal: controller.signal });
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
 * The status-agnostic sibling of fetchJson for endpoints where non-2xx statuses
 * are protocol, not failure: the read route's 402 challenge (PAYMENT-REQUIRED
 * header + preview body), the 409 owned-re-pay refusal, and rate-limit 429s all
 * carry meaning in both body and headers. Any HTTP response with a JSON body is
 * `ok: true` here; only transport problems and a non-JSON body are failures.
 */
export interface FetchResponseOptions extends FetchJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON-serialized request body; callers stringify so the wire form is exact. */
  body?: string;
}

export interface FetchResponseSuccess {
  ok: true;
  status: number;
  json: unknown;
  /** Case-insensitive response-header getter (null when absent). */
  header: (name: string) => string | null;
  requestId?: string;
}

export type FetchResponseResult = FetchResponseSuccess | FetchJsonFailure;

export async function fetchResponse(
  url: string,
  opts: FetchResponseOptions,
): Promise<FetchResponseResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: opts.method ?? 'GET',
        signal: controller.signal,
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });
    } catch (err) {
      return timedOut
        ? timeoutFailure(url, opts.timeoutMs)
        : { ok: false, kind: 'network', message: `Request to ${url} failed: ${errorMessage(err)}` };
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
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
      header: (name) => res.headers.get(name),
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
