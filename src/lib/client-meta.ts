import pkg from '../../package.json';

/**
 * The `X-Tenjin-Client` value on every B2 request (spec 09 §purchase-attribution):
 * the server classifies views/payments by this label, so a CLI lookup-flow
 * purchase is never mixed with a web checkout. Format `tenjin-cli/<version>`.
 */
export const CLIENT_HEADER = `tenjin-cli/${pkg.version}`;
