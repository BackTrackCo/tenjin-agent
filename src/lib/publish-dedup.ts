import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushDir } from './paths';

/**
 * Same-machine publish dedup, keyed on the BODY rather than on a session id.
 *
 * The Stop hook's capture ask is guarded once per session, but the marker guards
 * the ASK and not the publish, and nothing downstream dedups: a live run
 * published five findings twice. Session id is the wrong key for it — two agents
 * watching related sessions are two session ids, and both are asked, and both
 * publish the same finding. One agent whose turn ends twice around a retry is
 * the same story with one id. What the two duplicates share is the text.
 *
 * So the key is the content hash, and the marker is machine-wide: it lives in
 * the push directory beside the capture markers, ages out on the same retention
 * from the same two pruners, and holds for every session on the machine.
 *
 * WHAT THIS IS NOT: a guarantee. It is a local optimisation, so it cannot cover
 * two machines publishing the same finding — that needs an idempotency key the
 * server honours, scoped to (shelf origin, publisher handle), which is filed
 * separately and deliberately not faked here with a client-side key the server
 * ignores.
 */

/** The marker prefix. Exported because BOTH pruners of the push directory have
 *  to agree about it: the Stop hook's pass ages these out, and the push core's
 *  pass must leave them alone exactly as it leaves `capture-` alone. */
export const PUBLISHED_MARKER_PREFIX = 'published-';

/**
 * The bytes the hash is taken over.
 *
 * A RE-RENDER OF THE SAME FINDING MUST HASH THE SAME, or the dedup catches
 * nothing: the duplicate is written by an agent asked the same question twice,
 * and the second file is the same prose with CRLF, a trailing blank line, or a
 * stray space at the end of a wrapped line. None of those are a different
 * finding. Interior whitespace is left alone, because a reflowed paragraph IS a
 * different body and silently treating it as a duplicate would swallow a real
 * publish.
 */
export function normalizePublishBody(bodyMd: string): string {
  return bodyMd
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** The content hash a marker is named for. */
export function publishBodyHash(bodyMd: string): string {
  return createHash('sha256').update(normalizePublishBody(bodyMd), 'utf8').digest('hex');
}

function markerPath(dataDir: string, bodyMd: string): string {
  return join(pushDir(dataDir), PUBLISHED_MARKER_PREFIX + publishBodyHash(bodyMd));
}

/**
 * The url this body was already published at, or null.
 *
 * Best-effort in both directions: an unreadable or empty marker reads as "not
 * published", because the failure mode of a false hit is a publish that silently
 * never happens, and the failure mode of a miss is the duplicate this exists to
 * reduce. The cheaper mistake wins.
 */
export function publishedUrlFor(dataDir: string, bodyMd: string): string | null {
  try {
    const url = readFileSync(markerPath(dataDir, bodyMd), 'utf8').trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Record that this body is published at `url`. Never the publish's problem: the
 *  post is already created by the time this runs, so a failure here costs a
 *  possible duplicate later and must not turn a successful publish into an
 *  error. Written through a temp file so a torn marker cannot be read as a url. */
export function recordPublished(dataDir: string, bodyMd: string, url: string): void {
  try {
    const path = markerPath(dataDir, bodyMd);
    const tmp = `${path}.${process.pid}.tmp`;
    mkdirSync(pushDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, url, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Bookkeeping only.
  }
}
