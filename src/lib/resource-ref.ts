import { CliError } from './errors';
import { findPairingCandidate, findStoredCandidate } from './state-store';
import { canonicalReadUrl } from './library';
import { UUID_RE } from './ids';
import { isSameDeployment } from './production-origin';
import { getPostMetadata } from './agent-api';
import { trimSlash } from './url';
import type { ShelfBypass } from './http';

/**
 * Resolve a `<resource-url-or-id>` CLI argument to the payable read URL. A full
 * http(s) URL must live on the configured deployment; a bare uuid is a
 * resourceId, resolved to its URL first through the local search store (the read
 * route is keyed by handle/slug, so an id alone cannot build the URL on its own),
 * then — when a caller supplies `net` — through the public by-id route
 * (`getPostMetadata`), for an id neither local source has ever seen. Anything
 * else is a usage error with a clear fix.
 *
 * The origin pin is a MONEY-PATH trust boundary, not pedantry: `buy` sends a
 * wallet-signed SIWX header (a bearer credential scoped to the configured
 * domain) and an EIP-3009 payment authorization to whatever host the resolved
 * URL names. An off-origin URL, whether typed by hand or planted in a search
 * candidate, would hand both to that host. Nothing signed may leave for a
 * deployment the user did not configure: `isSameDeployment` widens "origin" to
 * the alias set of the one deployment the base already names, never past it.
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
  /**
   * The shelf this ref lives on, as a base URL. Equal to the configured
   * `baseUrl` for everything but a public-shelf candidate resolved in team mode.
   *
   * It exists because a wallet signature is BOUND TO A DOMAIN: `buy` builds a
   * SIWX header for a base URL, and signing for the team shelf while requesting
   * the public one produces a credential the public one will reject — or, worse,
   * a habit of signing for whichever host is configured rather than the one
   * being talked to. Callers sign against this, not against the config.
   */
  shelfBaseUrl: string;
}

/**
 * Throws USAGE unless `url` parses and shares the base URL's origin, or names
 * the same deployment under `isSameDeployment` — which is the SAME server, not a
 * second one the CLI now trusts. Aliasing applies only when the configured base
 * is one of the deployment's own origins; a self-hosted base keeps the exact
 * compare, and every other origin is refused on the terms it always was.
 *
 * `alsoAllow` is the SECOND SHELF, and it widens this by exactly one origin the
 * operator configured themselves (`publicShelfUrl`). Team mode searches two
 * shelves, so it surfaces candidates from two origins, and a `read` that
 * refused every public-shelf hit would make the fallback leg useless. It is
 * still a configured origin, checked the same way, and never a value that
 * arrived from a response.
 */
export function assertOnBaseOrigin(
  url: string,
  baseUrl: string,
  what: string,
  alsoAllow?: string,
): void {
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
  if (alsoAllow !== undefined && onOrigin(target.origin, alsoAllow)) return;
  if (!isSameDeployment(target.origin, base.origin)) {
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

/** Is `origin` the origin of `baseUrl`? False for a `baseUrl` that will not parse
 *  — an unusable second shelf widens nothing. */
function onOrigin(origin: string, baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === origin;
  } catch {
    return false;
  }
}

/** The network capability a bare-id resolution falls back on (see below). Left
 *  optional and threaded through explicitly rather than defaulted to the
 *  global `fetch`, so a caller that omits it gets exactly today's local-only
 *  resolution — no test or seam has to stub a network it never asked for. */
export interface ResourceRefNetOptions {
  timeoutMs: number;
  bypass?: ShelfBypass;
  fetchImpl?: typeof fetch;
}

export async function resolveResourceRef(
  arg: string,
  dataDir: string,
  baseUrl: string,
  publicShelfUrl?: string,
  net?: ResourceRefNetOptions,
): Promise<ResourceRef> {
  // The second shelf only widens anything when it is a DIFFERENT origin; in
  // public mode the two are the same and this is a no-op.
  const alsoAllow =
    publicShelfUrl !== undefined && !onOrigin(safeOrigin(baseUrl), publicShelfUrl)
      ? publicShelfUrl
      : undefined;
  /** Which shelf the resolved URL is on, for the caller's SIWX domain. */
  const shelfFor = (url: string): string =>
    alsoAllow !== undefined && onOrigin(safeOrigin(url), alsoAllow) ? alsoAllow : baseUrl;

  const trimmed = arg.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = canonicalReadUrl(trimmed);
    assertOnBaseOrigin(url, baseUrl, 'resource URL', alsoAllow);
    return { url, shelfBaseUrl: shelfFor(url) };
  }
  if (UUID_RE.test(trimmed)) {
    // A search candidate first (the ordinary case), then a pairing this
    // machine's own `tenjin sync` published (tenjin-agent#252): `sync` never
    // records what it publishes as a search result, so an id straight out of
    // its own output would otherwise refuse to resolve here even though the
    // CLI is the one that minted it.
    const candidate =
      (await findStoredCandidate(dataDir, trimmed)) ??
      (await findPairingCandidate(dataDir, trimmed));
    if (candidate === null) {
      // Both local sources miss. The one id-only route left is the public
      // by-id lookup (tenjin#803, `getPostMetadata`): it is what lets an id
      // this CLI's own `tenjin publish` just returned resolve immediately,
      // without a `tenjin search` round trip to plant it in the local store
      // first. Only attempted when a caller actually supplied network
      // capability — see `ResourceRefNetOptions`.
      const remote = net !== undefined ? await getPostMetadata(trimmed, { baseUrl, ...net }) : null;
      if (remote === null) {
        throw new CliError(
          'RESOURCE_NOT_FOUND',
          net !== undefined
            ? `Resource ${trimmed} is not known locally or on the shelf.`
            : `No local search knows resource ${trimmed}.`,
          {
            fix: 'Run `tenjin search` to surface it first, or pass the full read URL.',
          },
        );
      }
      // The read route is keyed by handle/slug, never by id, so this is the
      // one place that shape is built rather than read off a stored/served
      // candidate. Re-asserted like every other arm below: the metadata came
      // back on `baseUrl`, but the origin check is what makes that a proof
      // rather than an assumption.
      const url = canonicalReadUrl(
        `${trimSlash(baseUrl)}/api/read/${encodeURIComponent(remote.creator.handle)}/${encodeURIComponent(remote.slug)}`,
      );
      assertOnBaseOrigin(url, baseUrl, 'resolved candidate URL', alsoAllow);
      return { url, resourceId: trimmed, shelfBaseUrl: shelfFor(url) };
    }
    // The stored url was origin-checked at search time, but the config can have
    // changed since; re-assert against the CURRENT base URL before any send.
    // Canonicalized on the same terms as a hand-typed URL: the server's own
    // candidates arrive without a trailing slash, so this is insurance against a
    // deployment that ever emits one, not a case seen in practice.
    const url = canonicalReadUrl(candidate.url);
    assertOnBaseOrigin(url, baseUrl, 'stored candidate URL', alsoAllow);
    return { url, resourceId: trimmed, shelfBaseUrl: shelfFor(url) };
  }
  throw new CliError('USAGE', `Not a resource URL or id: ${JSON.stringify(arg)}`, {
    fix: 'Pass a full https read URL (a candidate `url`) or a resourceId uuid.',
  });
}

/** `URL.origin`, or a sentinel that matches nothing, for a string that will not
 *  parse. The callers above all re-check through `assertOnBaseOrigin`, which is
 *  where an unparseable URL becomes the USAGE error. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '\0';
  }
}
