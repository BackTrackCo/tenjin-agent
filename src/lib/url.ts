import { CliError } from './errors';

/** Drop trailing slashes from a base URL so `${base}/path` never doubles a slash. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The `scheme://host[:port]` of an http(s) URL, or null if it is not one.
 *
 * Non-http schemes are rejected rather than passed through, and that is the whole
 * reason this is not a one-line `new URL(url).origin`: for any non-special
 * scheme the WHATWG origin is the opaque string `"null"`, so `foo://tenjin.blog`
 * and `bar://evil.example` compare EQUAL. This value binds a wallet-derived
 * credential to one deployment, so an equal-comparing sentinel is exactly the
 * failure it exists to prevent — the same shape as the unparseable case, just
 * spelled differently.
 */
export function tryOriginOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * `tryOriginOf` for callers that cannot proceed without an origin. Throws USAGE
 * rather than returning a sentinel; anything that must survive a bad base URL
 * (diagnostics, above all) uses `tryOriginOf` and handles the null.
 */
export function originOf(url: string): string {
  const origin = tryOriginOf(url);
  if (origin === null) {
    throw new CliError('USAGE', `Invalid base URL: ${JSON.stringify(url)}`, {
      fix: 'Set an absolute http(s) base URL: `tenjin config set baseUrl <url>`.',
    });
  }
  return origin;
}
