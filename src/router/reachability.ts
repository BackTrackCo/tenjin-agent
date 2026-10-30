import { envProxySupported, proxyVariable } from '../lib/env-proxy';
import { httpRequest, type HttpResponse } from '../lib/http';
import { isSameDeployment, PRODUCTION_ORIGIN } from '../lib/production-origin';
import { ROUTE_PAID_PATH } from './decision';
import { ROUTING_FEE_CEILING_ATOMIC, usd } from './fee';

export interface RouterCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  required: boolean;
  detail: string;
  fix?: string;
  /** false only when the check could not run: rendered warn, never ok, never counted "to act on". */
  checked?: false;
}

/**
 * One cheap request to the paid route every routing call takes, in the `warm`
 * form, which never runs a gate: nothing is signed and no Jev request is
 * spent. The paywall answers a request with no payment 402 before it reads
 * the body, so a 402 is the route live and charging, and its quote is read:
 * one above `ROUTING_FEE_CEILING_ATOMIC` warns, since every routing call is
 * then skipped. A 200 is the route live with the fee off, and a 400 one with
 * no `warm` form refusing the body; a 404 is the route switched off, and a
 * 5xx a route erroring. `doctor` fails on it; `install` only warns.
 *
 * A refusal is blamed on the layer that sent it. A proxy, firewall or VPN that
 * blocks the host is not the origin asking for credentials, and on the
 * production base URL the fix is never "set the base URL", because that is the
 * one setting that is already right.
 */
export async function probeRouter(
  baseUrl: string,
  opts: {
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    /** Test seam; production asks this Node whether it can use the proxy. */
    proxySupported?: boolean;
  },
): Promise<RouterCheck> {
  const fail = (detail: string, fix: string): RouterCheck => ({
    name: 'router',
    status: 'fail',
    required: true,
    detail,
    fix,
  });
  // `TENJIN_BASE_URL` and `--base-url` reach here unvalidated. A throw would
  // fail an install that has already written everything else.
  let url: string;
  try {
    url = new URL(ROUTE_PAID_PATH, baseUrl).toString();
  } catch {
    return fail(
      `the base URL ${JSON.stringify(baseUrl)} is not a URL`,
      `Check TENJIN_BASE_URL, or set it with \`tenjin config set baseUrl ${PRODUCTION_ORIGIN}\`.`,
    );
  }
  const host = new URL(url).host;
  const probe = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    blockRedirects: true,
    // A reachability check, not use: it must not count this machine as an install.
    anonymous: true,
    jsonBody: { schemaVersion: 1, warm: true },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const production = isSameDeployment(new URL(url).origin, PRODUCTION_ORIGIN);
  const checkBase = production
    ? 'Try again later.'
    : 'Check that the configured base URL names the Tenjin router (`tenjin config get baseUrl`), then try again later.';
  const env = opts.env ?? process.env;
  const network = networkFix(host, env, production, opts.proxySupported ?? envProxySupported());
  const credentials = proxyCredentialsFix(env);
  // Off production, a host that does not resolve or answer is most likely a
  // typo or a dev server that is not running, not a blocked network.
  const unreached = production ? network : checkBase;
  if (!probe.ok) {
    const t = probe.transport;
    if (t?.layer === 'proxy' && t.proxyStatus === 407) {
      return fail(
        `a proxy between this machine and ${host} asked for its own credentials (407)`,
        credentials,
      );
    }
    if (t?.layer === 'proxy') {
      return fail(
        `a proxy refused the connection to ${host} (${t.proxyStatus}), so the router never answered`,
        unreached,
      );
    }
    if (t?.layer === 'dns') {
      return fail(`${host} did not resolve (${t.code}), so the router was not reached`, unreached);
    }
    if (t?.layer === 'tls') {
      return fail(
        `the TLS connection to ${host} failed (${t.code}). A proxy that inspects TLS causes this`,
        `If this network inspects TLS, set NODE_EXTRA_CA_CERTS to its CA certificate. ${unreached}`,
      );
    }
    if (t?.layer === 'connect') {
      return fail(`could not connect to ${host} (${t.code})`, unreached);
    }
    return fail(`the router at ${url} is unreachable or erroring (${probe.message})`, unreached);
  }
  if (probe.status === 402) {
    // Loaded only for a 402: it reads x402 headers, which install's and the
    // status line's shared chunk must not carry (`dist-chunks.test.ts`).
    const { quoteOf } = await import('./routing-quote');
    const quoted = quoteOf((name) => probe.header(name));
    if (quoted === null) {
      return {
        name: 'router',
        status: 'warn',
        required: true,
        detail: `${url} asks for a payment this CLI cannot read, so routing calls are skipped`,
        fix: checkBase,
      };
    }
    if (quoted > ROUTING_FEE_CEILING_ATOMIC) {
      return {
        name: 'router',
        status: 'warn',
        required: true,
        detail: `${url} quotes $${usd(quoted)} a routing call, more than the $${usd(ROUTING_FEE_CEILING_ATOMIC)} this CLI pays, so every routing call is skipped`,
        fix: 'Routing resumes once the router quotes within that. Your usual tools still work.',
      };
    }
    return { name: 'router', status: 'ok', required: true, detail: `${url} is live` };
  }
  // 429 is the route's own rate limit: proof the router is there.
  if (probe.status === 200 || probe.status === 400 || probe.status === 429) {
    return { name: 'router', status: 'ok', required: true, detail: `${url} is live` };
  }
  if (probe.status === 404) {
    return fail(`the router is not enabled at ${url}`, checkBase);
  }
  if (probe.status === 407) {
    return fail(
      `a proxy between this machine and ${host} asked for its own credentials (407)`,
      credentials,
    );
  }
  if (probe.status === 401 || probe.status === 403) {
    if (!fromDeployment(probe)) {
      return fail(
        `${host} answered ${probe.status} without the headers a Tenjin deployment sends, so a proxy, firewall or VPN on the way most likely refused the request`,
        network,
      );
    }
    if (production) {
      return fail(`${url} refused this machine (${probe.status})`, checkBase);
    }
    return fail(
      `${url} is not a Tenjin router (it asked for credentials)`,
      `Set the router URL with \`tenjin config set baseUrl ${PRODUCTION_ORIGIN}\`.`,
    );
  }
  if (probe.status >= 500) {
    return fail(`the router at ${url} is unreachable or erroring (${probe.status})`, checkBase);
  }
  return fail(
    `${url} answered ${probe.status}, which a Tenjin router does not`,
    'Check that the configured base URL names a Tenjin deployment (`tenjin config get baseUrl`).',
  );
}

/**
 * Did the origin send this, rather than something in front of it? Every Vercel
 * response carries `x-vercel-id` (its own access protection included), and
 * every Tenjin API route adds `x-request-id`. A block page from a proxy,
 * firewall or VPN carries neither.
 */
function fromDeployment(probe: HttpResponse): boolean {
  return probe.header('x-vercel-id') !== undefined || probe.header('x-request-id') !== undefined;
}

function networkFix(
  host: string,
  env: NodeJS.ProcessEnv,
  production: boolean,
  proxySupported: boolean,
): string {
  const proxy = proxyVariable(env);
  const config = production ? " Tenjin's own config is correct and needs no change." : '';
  if (proxy !== undefined && !proxySupported) {
    return `This shell sets ${proxy}, but Node ${process.versions.node} cannot send Tenjin's requests through it. Upgrade to Node 24.14 or newer, or run from a network that reaches ${host} directly.${config}`;
  }
  const via = proxy !== undefined ? ` (this shell sets ${proxy})` : '';
  return `Allow ${host} through your proxy, firewall or VPN${via}, or run from a network that reaches it.${config}`;
}

function proxyCredentialsFix(env: NodeJS.ProcessEnv): string {
  const proxy = proxyVariable(env) ?? 'HTTPS_PROXY';
  return `Put the proxy's credentials in ${proxy} (\`http://user:password@proxy:port\`), then try again.`;
}
