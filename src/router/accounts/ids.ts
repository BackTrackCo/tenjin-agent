/**
 * THE NAMES A CONNECTED ACCOUNT IS KEPT UNDER. Safe in a hook: no I/O.
 *
 * An account id is what the router calls its source (`apify`), and this
 * client keeps the account's credential under it: the vault file
 * `sources/<id>.json` and the OS-store account `source:<id>`. So it is
 * narrower than a target id: lowercase letters, digits and dashes, which no
 * file system, shell or keychain command line reads as anything else.
 */

/** 1 to 48 of `[a-z0-9-]`, starting with a letter or digit; never `tenjin`. */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** The built-in source, which is never connected. */
const BUILT_IN = 'tenjin';

export function isAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id) && id !== BUILT_IN;
}

/** The OS-store accounts a vault key may be kept under: `source:<id>`. */
export const STORE_ACCOUNT = /^source:[a-z0-9][a-z0-9-]{0,47}$/;

/** The OS-store account that holds an account's vault key. */
export function storeAccountFor(id: string): string {
  if (!isAccountId(id)) throw new Error(`not an account id: ${id}`);
  return `source:${id}`;
}

/**
 * The id an account connected by its URL alone is kept under, from the host:
 * `https://mcp.example.com/mcp` is `mcp-example-com`. Two addresses on one host
 * get one id, so the second is refused until the first is disconnected.
 */
export function accountIdForUrl(url: URL): string {
  const id = url.hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return isAccountId(id) ? id : 'account';
}
