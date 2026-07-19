import { CliError } from './errors';
import { findCandidate, findLibraryByResource } from './state';

/**
 * The one form every command works with: the payable read-API URL plus the
 * handle/slug identity it encodes. `inspect`/`buy` accept several spellings
 * (read-API URL, browser /a/ URL, handle/slug shorthand, or a resourceId from a
 * prior lookup) and all collapse here.
 */
export interface ResourceRef {
  url: string;
  handle: string;
  slug: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

export function readApiUrl(baseUrl: string, handle: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/read/${handle}/${slug}`;
}

/**
 * Resolve a user-supplied reference to a ResourceRef. A resourceId resolves only
 * through local state (lookup history or the library): the read API is keyed by
 * handle/slug, and the CLI never guesses at a mapping the server didn't hand it.
 * URLs on a different origin than the configured base are refused, because the
 * CLI talks only to the configured base URL (spec 10 invariant).
 */
export async function resolveResourceRef(
  ref: string,
  baseUrl: string,
  dataDir: string,
): Promise<ResourceRef> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new CliError('USAGE', 'Empty resource reference.', { fix: REF_FIX });
  }

  if (UUID_RE.test(trimmed)) {
    const hit = await findCandidate(dataDir, trimmed);
    if (hit !== null) return fromUrl(hit.candidate.url, baseUrl);
    const owned = await findLibraryByResource(dataDir, trimmed);
    if (owned !== null) return fromUrl(owned.url, baseUrl);
    throw new CliError(
      'USAGE',
      `Unknown resource id ${trimmed}: not in local lookup history or library.`,
      {
        fix: 'Pass the resource URL or handle/slug instead, or run `tenjin lookup` first.',
      },
    );
  }

  if (/^https?:\/\//i.test(trimmed)) return fromUrl(trimmed, baseUrl);

  if (HANDLE_SLUG_RE.test(trimmed)) {
    const [handle, slug] = trimmed.split('/') as [string, string];
    return { url: readApiUrl(baseUrl, handle, slug), handle, slug };
  }

  throw new CliError('USAGE', `Unrecognized resource reference: ${JSON.stringify(ref)}`, {
    fix: REF_FIX,
  });
}

const REF_FIX =
  'Pass a read URL (https://tenjin.blog/api/read/<handle>/<slug>), a handle/slug pair, or a resourceId from a prior lookup.';

function fromUrl(raw: string, baseUrl: string): ResourceRef {
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(baseUrl);
  } catch {
    throw new CliError('USAGE', `Invalid resource URL: ${JSON.stringify(raw)}`, { fix: REF_FIX });
  }
  if (url.origin !== base.origin) {
    throw new CliError(
      'USAGE',
      `Resource URL origin ${url.origin} does not match the configured base URL ${base.origin}.`,
      {
        fix: 'The CLI only talks to the configured base URL. Pass --base-url if you meant a different deployment.',
      },
    );
  }
  const readMatch = url.pathname.match(/^\/api\/read\/([^/]+)\/([^/]+)\/?$/);
  if (readMatch !== null) {
    const [, handle, slug] = readMatch as unknown as [string, string, string];
    return { url: readApiUrl(baseUrl, handle, slug), handle, slug };
  }
  const browserMatch = url.pathname.match(/^\/a\/([^/]+)\/([^/]+)\/?$/);
  if (browserMatch !== null) {
    const [, handle, slug] = browserMatch as unknown as [string, string, string];
    return { url: readApiUrl(baseUrl, handle, slug), handle, slug };
  }
  throw new CliError('USAGE', `URL path ${url.pathname} is not a readable resource.`, {
    fix: REF_FIX,
  });
}
