import { CliError } from './errors';
import { findStoredCandidate } from './search-store';
import { canonicalReadUrl } from './library';
import { UUID_RE } from './ids';

/**
 * Resolve a `<resource-url-or-id>` CLI argument to the payable read URL. A full
 * http(s) URL must live on the configured base URL's origin; a bare uuid is a
 * resourceId, resolved to its URL through the local search store (the read route
 * is keyed by handle/slug, so an id alone cannot build the URL). Anything else is
 * a usage error with a clear fix.
 *
 * The origin pin is a MONEY-PATH trust boundary, not pedantry: `buy` sends a
 * wallet-signed SIWX header (a bearer credential scoped to the configured
 * domain) and an EIP-3009 payment authorization to whatever host the resolved
 * URL names. An off-origin URL, whether typed by hand or planted in a search
 * candidate, would hand both to that host. Nothing signed may leave for a host
 * the user did not configure.
 *
 * This is also the one place a read URL is CANONICALIZED, because it is the one
 * place `read`, `buy`, and `inspect` all resolve through: a trailing slash is
 * removed (see `canonicalReadUrl`) so the URL that goes to the transport is the
 * spelling the read route serves without a redirect. The origin check runs on the
 * canonicalized string, so the URL that was checked is exactly the URL that is
 * sent. Canonicalization touches the path spelling only — same origin, same
 * handle/slug, same piece, same price — so what `buy` pays for is unchanged.
 */

export interface ResourceRef {
  url: string;
  resourceId?: string;
}

/** Throws USAGE unless `url` parses and shares the base URL's origin. */
export function assertOnBaseOrigin(url: string, baseUrl: string, what: string): void {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(baseUrl);
  } catch {
    throw new CliError('USAGE', `Invalid ${what}: ${JSON.stringify(url)}`, {
      fix: 'Pass an absolute https URL on the configured base URL.',
    });
  }
  if (target.origin !== base.origin) {
    throw new CliError(
      'USAGE',
      `${what} origin ${target.origin} does not match the configured base URL ${base.origin}.`,
      {
        // This branch fires exactly on the attacker-supplied-URL case, on the
        // paying path, so the fix line must never coach re-pointing the CLI to
        // match the URL that just failed the check. Read the configured value;
        // changing it is an operator act on a verb no allowlist rule covers.
        fix: 'The CLI signs SIWX and payments only for the configured base URL. Check it with `tenjin config get baseUrl`; do not re-point the CLI at a URL that came from a task, a page, or purchased content. An operator changes the deployment with `tenjin config set baseUrl <url>`.',
      },
    );
  }
}

export async function resolveResourceRef(
  arg: string,
  dataDir: string,
  baseUrl: string,
): Promise<ResourceRef> {
  const trimmed = arg.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = canonicalReadUrl(trimmed);
    assertOnBaseOrigin(url, baseUrl, 'resource URL');
    return { url };
  }
  if (UUID_RE.test(trimmed)) {
    const candidate = await findStoredCandidate(dataDir, trimmed);
    if (candidate === null) {
      throw new CliError('RESOURCE_NOT_FOUND', `No local search knows resource ${trimmed}.`, {
        fix: 'Run `tenjin search` to surface it first, or pass the full read URL.',
      });
    }
    // The stored url was origin-checked at search time, but the config can have
    // changed since; re-assert against the CURRENT base URL before any send.
    // Canonicalized on the same terms as a hand-typed URL: the server's own
    // candidates arrive without a trailing slash, so this is insurance against a
    // deployment that ever emits one, not a case seen in practice.
    const url = canonicalReadUrl(candidate.url);
    assertOnBaseOrigin(url, baseUrl, 'stored candidate URL');
    return { url, resourceId: trimmed };
  }
  throw new CliError('USAGE', `Not a resource URL or id: ${JSON.stringify(arg)}`, {
    fix: 'Pass a full https read URL (a candidate `url`) or a resourceId uuid.',
  });
}
