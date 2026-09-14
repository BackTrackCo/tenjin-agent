import type { CookieSerializeOptions, SetCookie } from "cookie-es";

/**
 * Cookies are unique by "cookie-name, domain-value, and path-value".
 *
 * @see https://httpwg.org/specs/rfc6265.html#rfc.section.4.1.2
 */
export function getDistinctCookieKey(
  name: string,
  opts: CookieSerializeOptions | SetCookie,
) {
  return [name, opts.domain || "", opts.path || "/"].join(";");
}
