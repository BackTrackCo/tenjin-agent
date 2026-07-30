import { CliError } from './errors';

/** Drop trailing slashes from a base URL so `${base}/path` never doubles a slash. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The `scheme://host[:port]` of a URL. Used to bind a cached credential to the
 * deployment it was minted for; throws USAGE on anything unparseable rather than
 * returning a sentinel that would compare equal to another bad value.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new CliError('USAGE', `Invalid base URL: ${JSON.stringify(url)}`, {
      fix: 'Set an absolute https base URL: `tenjin config set baseUrl <url>`.',
    });
  }
}
