import { httpRequest } from './http';

/**
 * GITHUB'S DEVICE FLOW (RFC 8628), for event codes that are one per person:
 * `tenjin redeem` asks GitHub for a short code, the person enters it at
 * github.com/login/device, and this polls until GitHub hands back an access
 * token, which the redeem call sends once so the server can check the account.
 *
 * - The OAuth app's client ID comes from the server's refusal
 *   (`promo_github_required`), never from this build.
 * - Both endpoints are pinned to github.com, and neither request follows a
 *   redirect. The verification page must be https://github.com/…, or it is
 *   refused unopened: a compromised answer cannot steer the browser.
 * - The token is returned to the caller and nothing else: never written to
 *   disk, printed, or kept here. The scope is empty, so it grants no access
 *   beyond reading the account's public profile.
 *
 * Failure is a value, not a throw, so the caller words it for its own command.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REQUEST_TIMEOUT_MS = 10_000;
/** RFC 8628's default interval, and what slow_down adds to it. */
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;
/** GitHub's codes last 15 minutes; a longer claim is held to this. */
const MAX_EXPIRES_S = 30 * 60;
/** A network that fails this many polls in a row is down, not blipping. */
const MAX_NETWORK_FAILURES = 3;
/** A GitHub OAuth client ID: `Iv1.…`, `Ov23li…`, or 20 hex characters. */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

export interface DeviceCode {
  deviceCode: string;
  /** What the person types at the verification page, like `ABCD-1234`. */
  userCode: string;
  /** https://github.com/login/device, checked. */
  verificationUri: string;
  expiresInS: number;
  intervalS: number;
}

export type DeviceCodeResult =
  | { ok: true; code: DeviceCode }
  /** `network`: GitHub did not answer. `refused`: it answered with an error. `malformed`: not a device code, or a page off github.com. */
  | { ok: false; reason: 'network' | 'refused' | 'malformed'; detail?: string };

export type TokenResult =
  | { ok: true; token: string }
  /**
   * `expired`: the code ran out before the person approved it. `denied`: they
   * cancelled on GitHub. `network`: GitHub stopped answering. `refused`: any
   * other OAuth error, named in `detail`.
   */
  | { ok: false; reason: 'expired' | 'denied' | 'network' | 'refused'; detail?: string };

export interface DeviceFlowOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function validClientId(raw: unknown): raw is string {
  return typeof raw === 'string' && CLIENT_ID.test(raw);
}

/** Step one: a device code and the code the person types. */
export async function requestDeviceCode(
  clientId: string,
  opts: DeviceFlowOptions = {},
): Promise<DeviceCodeResult> {
  const res = await post(DEVICE_CODE_URL, { client_id: clientId, scope: '' }, opts);
  if (!res.ok) return { ok: false, reason: 'network' };
  const body = record(res.json);
  if (typeof body?.error === 'string') {
    return { ok: false, reason: 'refused', detail: body.error.slice(0, 80) };
  }
  if (res.status !== 200 || body === undefined) {
    return { ok: false, reason: 'refused', detail: `HTTP ${res.status}` };
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  if (
    typeof device_code !== 'string' ||
    device_code.length === 0 ||
    device_code.length > 200 ||
    typeof user_code !== 'string' ||
    !/^[A-Z0-9-]{4,20}$/i.test(user_code) ||
    typeof verification_uri !== 'string' ||
    !onGithub(verification_uri)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    code: {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresInS: seconds(expires_in, 15 * 60, MAX_EXPIRES_S),
      intervalS: seconds(interval, DEFAULT_INTERVAL_S, 60),
    },
  };
}

/**
 * Step two: poll until the person approves, cancels, or the code runs out.
 * It waits the interval before every request, adds five seconds on each
 * slow_down, and stops at the code's own expiry.
 */
export async function pollForToken(
  clientId: string,
  code: DeviceCode,
  opts: DeviceFlowOptions = {},
): Promise<TokenResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + code.expiresInS * 1000;
  let intervalS = code.intervalS;
  let networkFailures = 0;
  for (;;) {
    await sleep(intervalS * 1000);
    if (now() >= deadline) return { ok: false, reason: 'expired' };
    const res = await post(
      TOKEN_URL,
      { client_id: clientId, device_code: code.deviceCode, grant_type: GRANT_TYPE },
      opts,
    );
    // No answer and a 5xx both count toward the limit; only a real answer resets it.
    if (!res.ok || res.status >= 500) {
      networkFailures += 1;
      if (networkFailures >= MAX_NETWORK_FAILURES) return { ok: false, reason: 'network' };
      continue;
    }
    networkFailures = 0;
    const body = record(res.json);
    const token = body?.access_token;
    if (typeof token === 'string' && token.length > 0 && token.length <= 512) {
      return { ok: true, token };
    }
    const error = body?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      // GitHub names the new interval; RFC 8628 says add five seconds either way.
      intervalS = Math.max(intervalS + SLOW_DOWN_S, seconds(body?.interval, 0, 120));
      continue;
    }
    if (error === 'expired_token') return { ok: false, reason: 'expired' };
    if (error === 'access_denied') return { ok: false, reason: 'denied' };
    return {
      ok: false,
      reason: 'refused',
      detail: typeof error === 'string' ? error.slice(0, 80) : `HTTP ${res.status}`,
    };
  }
}

/** An https page on github.com itself, with no credentials or port in it. */
function onGithub(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.host === 'github.com' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function post(url: string, form: Record<string, string>, opts: DeviceFlowOptions) {
  return httpRequest(url, {
    method: 'POST',
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    rawBody: new URLSearchParams(form).toString(),
    blockRedirects: true,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

function record(json: unknown): Record<string, unknown> | undefined {
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
}

/** A whole number of seconds in [1, max], else `fallback`. */
function seconds(raw: unknown, fallback: number, max: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
    ? Math.min(raw, max)
    : fallback;
}
