import { createHash } from 'node:crypto';
import { openStore, STORE_SQL } from './state-store';

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
 * So the key is the content hash, and the record is machine-wide: it is a
 * `session_state` row under the '' (machine) session, keyed `published:<hash>`,
 * and it holds for every session on the machine. It used to be a marker file in
 * the push directory, aged out by two separate pruners that each had to be told
 * not to sweep it early — a swept marker is a duplicate post, the exact thing it
 * exists to prevent. The row has no mtime and no pruner.
 *
 * WHAT THIS IS NOT: a guarantee. It is a local optimisation, so it cannot cover
 * two machines publishing the same finding — that needs an idempotency key the
 * server honours, scoped to (shelf origin, publisher handle), which is filed
 * separately and deliberately not faked here with a client-side key the server
 * ignores.
 */

/** The `session_state` key prefix. ⚠ MIRRORED with `STATE_PUBLISHED_PREFIX` in
 *  lib/state-store.ts, which is what the generated hooks see. */
export const PUBLISHED_KEY_PREFIX = 'published:';

/** The machine-wide bucket these rows live in; see the DDL note on `session`. */
const MACHINE_SESSION = '';

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

function publishedKey(bodyMd: string): string {
  return PUBLISHED_KEY_PREFIX + publishBodyHash(bodyMd);
}

/**
 * The url this body was already published at, or null.
 *
 * Best-effort in both directions: an unreadable or empty row reads as "not
 * published", because the failure mode of a false hit is a publish that silently
 * never happens, and the failure mode of a miss is the duplicate this exists to
 * reduce. The cheaper mistake wins.
 */
export async function publishedUrlFor(dataDir: string, bodyMd: string): Promise<string | null> {
  const store = await openStore(dataDir);
  if (store === null) return null;
  try {
    const row = store.get(STORE_SQL.getState, [MACHINE_SESSION, publishedKey(bodyMd)]);
    if (row === null || typeof row.value !== 'string') return null;
    const url = JSON.parse(row.value);
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/** Record that this body is published at `url`. Never the publish's problem: the
 *  post is already created by the time this runs, so a failure here costs a
 *  possible duplicate later and must not turn a successful publish into an
 *  error. */
export async function recordPublished(dataDir: string, bodyMd: string, url: string): Promise<void> {
  const store = await openStore(dataDir);
  if (store === null) return;
  try {
    store.run(STORE_SQL.setState, [
      MACHINE_SESSION,
      publishedKey(bodyMd),
      JSON.stringify(url),
      Date.now(),
    ]);
  } finally {
    store.close();
  }
}
