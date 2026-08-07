import pkg from '../../package.json';

/**
 * The CLI's identity on every HTTP request, sent as the standard `User-Agent`
 * header from the shared transport (`http.ts`). The server's
 * `parseUserAgentProduct()` (tenjin PR #544) reads the leading RFC 9110 product
 * token (`tenjin-cli/<version>`) for canonical attribution; `X-Tenjin-Client` is
 * retired and this CLI sends it nowhere.
 */
export const TENJIN_USER_AGENT = `tenjin-cli/${pkg.version} (+https://tenjin.blog)`;
