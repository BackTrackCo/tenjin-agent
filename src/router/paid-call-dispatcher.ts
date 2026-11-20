import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

/**
 * The HTTP timeouts of a paid model call. Node's own fetch cuts a request whose headers or
 * body wait more than 300 s (undici's defaults), which is below the deadline a router may
 * offer for a call (`maxCallDurationMs`) and below a stream's own idle limit, so a long
 * whole answer was cut by the client and left uncertain. The call's own deadline and idle
 * limit bound it instead: these only stay out of their way.
 */
const MARGIN_MS = 60_000;
const kept = new Map<string, Dispatcher>();

/**
 * A dispatcher whose headers and body waits are at least the call's deadline and its
 * stream idle limit, plus a minute. One per size, kept for the process. A proxy set for
 * Node (`NODE_USE_ENV_PROXY`) still applies, as it does to Node's own fetch.
 */
export function paidCallTimeouts(deadlineMs: number, idleMs: number) {
  return {
    headersTimeout: Math.min(deadlineMs + MARGIN_MS, 2 ** 31 - 1),
    bodyTimeout: Math.min(Math.max(deadlineMs, idleMs) + MARGIN_MS, 2 ** 31 - 1),
  };
}

export function paidCallDispatcher(deadlineMs: number, idleMs: number): Dispatcher {
  const { headersTimeout, bodyTimeout } = paidCallTimeouts(deadlineMs, idleMs);
  const proxied = ['1', 'true'].includes(String(process.env.NODE_USE_ENV_PROXY).toLowerCase());
  const key = `${proxied}:${headersTimeout}:${bodyTimeout}`;
  let dispatcher = kept.get(key);
  if (!dispatcher) {
    const options = { headersTimeout, bodyTimeout };
    dispatcher = proxied ? new EnvHttpProxyAgent(options) : new Agent(options);
    kept.set(key, dispatcher);
  }
  return dispatcher;
}
