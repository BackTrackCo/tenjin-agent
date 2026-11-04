import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import type { CommandContext } from '../context';
import { reportSpecOutcome, type IgnoredReason } from './decision';
import { HARNESSES, type Harness } from './names';
import { SPEC_TTL_MS } from './specs';

/**
 * THE OFFERS A HOST WAS SHOWN AND HAS NOT TAKEN, kept so the server hears
 * when one is ignored (the outcome status `ignored`). The hook that shows an
 * offer's line keeps it here ({@link noteShown}); the `request` tool drops it
 * as soon as a call names any id that line offered ({@link markTaken}); and
 * the next routed hook leg claims, once each, every offer whose 15 minutes ran
 * out (`expired`) and, before a native WebSearch or WebFetch, every offer the
 * same agent in the same session still holds (`native_after_offer`)
 * ({@link claimIgnored}).
 *
 * ONE FILE PER OFFER, FOR THE WHOLE MACHINE, so the last offers of a session
 * that ended are reported by the next leg of any session: no hook runs at a
 * session's end. A claim deletes the file, which only one of two racing legs
 * can do, so each id is reported once. Best effort throughout, like every
 * record the hooks keep: a lost file is one count fewer, and a report is the
 * outcome report's own fire-and-forget telemetry, with no text in it.
 */

const UNTAKEN_DIR = join('progress', 'untaken');
const FILE_RE = /^[a-f0-9]{64}\.json$/;
/** The server's id alphabet (`IdSchema`). */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A line names its own id, its specs' and a choice set's: far fewer than this. */
const MAX_IDS = 16;
/** Above this many files a claim leaves the rest for the next leg. */
const MAX_ENTRIES = 256;
const MAX_ENTRY_BYTES = 4_096;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** What is kept of one shown offer. */
export interface ShownOffer {
  /** The line's own id, which a report names. */
  id: string;
  /** Every id the line offered, its own first: a call naming any one takes it. */
  ids: string[];
  harness: Harness;
  /** {@link offerScope}: whose native call ignores it. Absent for an offer
   *  appended to a delegated task, which only the subagent could take. */
  scope?: string;
}

interface Entry extends ShownOffer {
  version: 1;
  at: number;
}

/** The agent an offer was shown to, in its session: a native call from the
 *  same agent in the same session, while it is untaken, ignored it. */
export function offerScope(session: string, agentId: string | undefined): string {
  return digest(JSON.stringify([session, agentId ?? '']));
}

/** Keep a shown offer until it is taken or reported. Never throws. */
export async function noteShown(
  dataDir: string,
  offer: ShownOffer,
  now: number = Date.now(),
): Promise<void> {
  if (!ID_RE.test(offer.id)) return;
  const ids = [...new Set([offer.id, ...offer.ids.filter((id) => ID_RE.test(id))])].slice(
    0,
    MAX_IDS,
  );
  const entry: Entry = { version: 1, at: now, ...offer, ids };
  await writeFileAtomic(
    join(dataDir, UNTAKEN_DIR, `${digest(offer.id)}.json`),
    JSON.stringify(entry),
    {
      mode: 0o600,
      dirMode: 0o700,
    },
  ).catch(() => undefined);
}

/**
 * A `request` call named this id: the offer it came from is taken, not ignored.
 * A line's own id names its file; any other id it offered is found by reading
 * every file, with no cap, since one left behind would be reported ignored.
 */
export async function markTaken(dataDir: string, id: string): Promise<void> {
  const own = join(dataDir, UNTAKEN_DIR, `${digest(id)}.json`);
  if ((await readEntry(own))?.ids.includes(id) === true) {
    await rm(own, { force: true }).catch(() => undefined);
    return;
  }
  for (const { path, entry } of await entries(dataDir, Infinity)) {
    if (entry?.ids.includes(id) === true) await rm(path, { force: true }).catch(() => undefined);
  }
}

/** One offer to report as ignored. */
export interface Ignored {
  id: string;
  harness: Harness;
  reason: IgnoredReason;
}

/**
 * CLAIM EVERY OFFER THAT IS NOW IGNORED, deleting each one's file so no other
 * leg reports it: those past their 15 minutes, and with `nativeScope`, those
 * shown to that agent before this leg began. A file that is not a whole entry
 * is removed. Never throws.
 */
export async function claimIgnored(
  dataDir: string,
  o: { now: number; nativeScope?: string },
): Promise<Ignored[]> {
  const claimed: Ignored[] = [];
  for (const { path, entry } of await entries(dataDir)) {
    if (entry === null) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    const reason: IgnoredReason | null =
      o.now - entry.at > SPEC_TTL_MS
        ? 'expired'
        : o.nativeScope !== undefined && entry.scope === o.nativeScope && entry.at <= o.now
          ? 'native_after_offer'
          : null;
    if (reason === null) continue;
    // Only the leg whose delete lands reports it.
    const won = await rm(path).then(
      () => true,
      () => false,
    );
    if (won) claimed.push({ id: entry.id, harness: entry.harness, reason });
  }
  return claimed;
}

/** Tell the server about each claimed offer, without waiting on any of it. */
export function reportIgnored(
  claimed: readonly Ignored[],
  deps: { ctx: CommandContext; baseUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  return Promise.all(
    claimed.map(({ id, harness, reason }) =>
      reportSpecOutcome(
        { id, status: 'ignored', reason },
        {
          ctx: deps.ctx,
          baseUrl: deps.baseUrl,
          harness,
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        },
      ),
    ),
  ).then(() => undefined);
}

/** The files here, up to `limit`, each with its entry, or null for one that
 *  is not a whole entry. */
async function entries(
  dataDir: string,
  limit = MAX_ENTRIES,
): Promise<{ path: string; entry: Entry | null }[]> {
  const dir = join(dataDir, UNTAKEN_DIR);
  const found: { path: string; entry: Entry | null }[] = [];
  try {
    const listing = await opendir(dir);
    for await (const item of listing) {
      if (!item.isFile() || !FILE_RE.test(item.name)) continue;
      const path = join(dir, item.name);
      found.push({ path, entry: await readEntry(path) });
      if (found.length >= limit) break;
    }
  } catch {
    // None kept yet, or not readable: nothing to report.
  }
  return found;
}

/** One entry, every field checked again: what is on disk is input. */
async function readEntry(path: string): Promise<Entry | null> {
  // O_NOFOLLOW: the directory is the user's, and a planted symlink must not
  // turn this read into a read of something else.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    if ((await file.stat()).size > MAX_ENTRY_BYTES) return null;
    const row = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
    const { at, id, ids, harness, scope } = row;
    if (row.version !== 1 || typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) return null;
    if (!(HARNESSES as readonly unknown[]).includes(harness)) return null;
    if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) {
      return null;
    }
    return {
      version: 1,
      at,
      id,
      ids: ids as string[],
      harness: harness as Harness,
      ...(scope !== undefined ? { scope } : {}),
    };
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}
