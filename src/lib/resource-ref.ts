import { CliError } from './errors';
import { findStoredCandidate } from './lookup-store';

/**
 * Resolve a `<resource-url-or-id>` CLI argument to the payable read URL. A full
 * http(s) URL is used verbatim (a lookup candidate's `url`); a bare uuid is a
 * resourceId, resolved to its URL through the local lookup store (the read route
 * is keyed by handle/slug, so an id alone cannot build the URL). Anything else is
 * a usage error with a clear fix.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResourceRef {
  url: string;
  resourceId?: string;
}

export async function resolveResourceRef(arg: string, dataDir: string): Promise<ResourceRef> {
  const trimmed = arg.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }
  if (UUID_RE.test(trimmed)) {
    const candidate = await findStoredCandidate(dataDir, trimmed);
    if (candidate === null) {
      throw new CliError('RESOURCE_NOT_FOUND', `No local lookup knows resource ${trimmed}.`, {
        fix: 'Run `tenjin lookup` to surface it first, or pass the full read URL.',
      });
    }
    return { url: candidate.url, resourceId: trimmed };
  }
  throw new CliError('USAGE', `Not a resource URL or id: ${JSON.stringify(arg)}`, {
    fix: 'Pass a full https read URL (a candidate `url`) or a resourceId uuid.',
  });
}
