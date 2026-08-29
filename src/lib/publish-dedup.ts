import { createHash } from 'node:crypto';
import {
  openStore,
  STORE_PUBLISHED_AGENT_PREFIX,
  STORE_QUEUE_RETENTION_MS,
  STORE_QUEUED_FINDING_PREFIX,
  STORE_SQL,
} from './state-store';

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

/**
 * Who this publish belongs to, beyond the body it published.
 *
 * BOTH FIELDS ARE ATTRIBUTION AND BOOKKEEPING, never authority: nothing above
 * reads either one, and a publish carrying both takes exactly the gates a bare
 * `tenjin publish file.md` takes.
 */
export interface PublishProvenance {
  /** The harness `agent_id` of the agent that ran the command, when it named
   *  one (`--agent`, which the SubagentStop capture ask fills in). */
  agentId?: string | null;
  /** The stored finding this body came from (`--finding`), which publishing
   *  takes off the unpublished queue. */
  findingId?: string | null;
}

/**
 * Record that this body is published at `url`, and who published it.
 *
 * Never the publish's problem: the post is already created by the time this
 * runs, so a failure here costs a possible duplicate later and must not turn a
 * successful publish into an error.
 *
 * THE AGENT ROW ANSWERS THE SUPERVISION ASYMMETRY (tenjin-agent#228). A child
 * asked at its own end publishes from a sidechain nobody reads; this row, keyed
 * on the same harness `agent_id` the hooks stamp into `events.data`, is what
 * lets the parent's own turn end report what its children published.
 *
 * ONE ROW PER PUBLISH, not one per agent. Keyed on the id alone the row was an
 * upsert, so a child that published something objectionable and then anything
 * innocuous left the parent's report showing only the second: the report is the
 * whole mitigation, and it silently dropped the publish worth seeing. The time
 * is appended after an `@`, a character the agent-id charset cannot contain, so
 * the reader recovers the id and the parent lists every publish.
 *
 * THE DEQUEUE IS WHY THE QUEUE IS A QUEUE. A finding stays listed in every
 * capture ask inside the window until something publishes it; without this the
 * ask would name the same published finding for hours, in every session.
 */
export async function recordPublished(
  dataDir: string,
  bodyMd: string,
  url: string,
  provenance: PublishProvenance = {},
): Promise<void> {
  const store = await openStore(dataDir);
  if (store === null) return;
  const at = Date.now();
  try {
    store.run(STORE_SQL.setState, [MACHINE_SESSION, publishedKey(bodyMd), JSON.stringify(url), at]);
    if (typeof provenance.agentId === 'string' && provenance.agentId !== '') {
      // PRUNE BEFORE THE INSERT, this prefix's half of STORE_QUEUE_RETENTION_MS.
      // The parent's report reads this prefix with no SQL LIMIT — a LIMIT there
      // spends its budget on already-reported rows and hides unreported ones
      // behind them — and `at` is a filter rather than an index on
      // `session_state`, so every row that ages out costs every later Stop
      // forever unless the writer takes it away.
      store.run(STORE_SQL.deleteStatePrefixBefore, [
        MACHINE_SESSION,
        STORE_PUBLISHED_AGENT_PREFIX,
        STORE_PUBLISHED_AGENT_PREFIX + String.fromCharCode(0xffff),
        at - STORE_QUEUE_RETENTION_MS,
      ]);
      store.run(STORE_SQL.setState, [
        MACHINE_SESSION,
        `${STORE_PUBLISHED_AGENT_PREFIX}${provenance.agentId}@${at}`,
        JSON.stringify({ url, at }),
        at,
      ]);
    }
    if (typeof provenance.findingId === 'string' && provenance.findingId !== '') {
      store.run(STORE_SQL.deleteState, [
        MACHINE_SESSION,
        STORE_QUEUED_FINDING_PREFIX + provenance.findingId,
      ]);
    }
  } finally {
    store.close();
  }
}

/**
 * Take a stored finding off the unpublished queue without recording a new
 * publish, and SAY WHETHER IT WENT.
 *
 * Two callers assert the outcome to the operator — the already-published short
 * circuit and `--discard`, which both print "it is off the queue" — so a
 * best-effort void was a claim neither of them could stand behind.
 *
 * IT ANSWERS "IS THE ROW OFF THE QUEUE", NOT "DID THIS DELETE IT". A row that
 * was already gone leaves the queue in exactly the state both callers are about
 * to describe, so it is a true answer — and a `changes > 0` test would turn a
 * publish followed by a discard into a false failure. The untrue answer is the
 * other one: a store this could not open, or a statement it could not run.
 */
export async function dequeueFinding(dataDir: string, findingId: string): Promise<boolean> {
  if (findingId === '') return false;
  const store = await openStore(dataDir);
  if (store === null) return false;
  try {
    store.run(STORE_SQL.deleteState, [MACHINE_SESSION, STORE_QUEUED_FINDING_PREFIX + findingId]);
    return true;
  } catch {
    return false;
  } finally {
    store.close();
  }
}
