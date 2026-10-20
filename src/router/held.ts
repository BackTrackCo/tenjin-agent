import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { EXPIRY_MS, pruneProgress, sanitize } from './progress';

/**
 * A NATIVE CALL HELD FOR TENJIN, as the mod draws its row. The pre-call hook
 * denies a WebSearch or WebFetch with an offer, and Claude Code would draw
 * that deny as a red hook error; the mod draws this row in its place instead.
 * One file per held call, keyed by the SHA-256 of the harness's own
 * `tool_use_id`, under `progress/held/`: not under a session's directory,
 * because the mod draws a row knowing its `tool_use_id` and nothing of the
 * session. Display only, like every progress record: a write that fails
 * leaves the engine's own row, and nothing here is read by routing or payment.
 *
 * `outcome` is `held` until the request tool runs that offer's id, which
 * marks it `routed` ({@link markRouted}), or until the same search or URL is
 * let run natively, which marks it `native` ({@link markNative}); a call
 * never made leaves it `held`. Recording only: neither mark changes what is
 * held, allowed or offered.
 * Every string is user text: the offer's label and its price, never the
 * reason the model read, the search, the URL or the input.
 */
export interface HeldRow {
  version: 1;
  at: number;
  outcome: 'held' | 'routed' | 'native';
  /** The offer's `label`, when the decision carried one. */
  label?: string;
  /** The provider's price, in atomic USDC. */
  priceAtomic?: string;
  /** The offer id the deny named, which the request tool's call carries back. */
  offerId: string;
  /** The native call that ran in its place, once `native`. */
  nativeToolUseId?: string;
  /** The request call that took it up, once `routed`, when the client named it. */
  routedToolUseId?: string;
}

/** The held call for one search or URL, so a native retry of it finds its row. */
interface HeldTarget {
  version: 1;
  at: number;
  toolUseId: string;
}

/** Which held calls named one offer id, so the request tool can find their rows. */
interface HeldIndex {
  version: 1;
  at: number;
  toolUseIds: string[];
}

export const HELD_DIR = join('progress', 'held');
/** Transcript rows redraw long after the turn, so a row outlives the footer's records. */
export const HELD_EXPIRY_MS = 24 * 60 * 60_000;
/** One offer id is named by a handful of parallel calls at most. */
const MAX_HELD_PER_OFFER = 8;
const MAX_RECORD_BYTES = 4_096;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function heldRowPath(dataDir: string, toolUseId: string): string {
  return join(dataDir, HELD_DIR, `${digest(toolUseId)}.json`);
}

function heldIndexPath(dataDir: string, offerId: string): string {
  return join(dataDir, HELD_DIR, `${digest(offerId)}.offer.json`);
}

/** Keyed by a digest of the tool and its search or URL, never the text itself. */
function heldTargetPath(dataDir: string, target: string): string {
  return join(dataDir, HELD_DIR, `${digest(`target\n${target}`)}.target.json`);
}

/** Record a held native call. Best effort: a lost row is the engine's own row. */
export async function markHeld(
  dataDir: string,
  toolUseId: string,
  offer: { offerId: string; label?: string; priceAtomic: string; target?: string },
  now = Date.now(),
): Promise<void> {
  await pruneProgress(join(dataDir, HELD_DIR), now, HELD_EXPIRY_MS);
  const row: HeldRow = {
    version: 1,
    at: now,
    outcome: 'held',
    ...(offer.label !== undefined ? { label: sanitize(offer.label, 32) } : {}),
    ...(/^\d{1,78}$/.test(offer.priceAtomic) ? { priceAtomic: offer.priceAtomic } : {}),
    offerId: offer.offerId,
  };
  if (!(await write(heldRowPath(dataDir, toolUseId), row))) return;
  const index = await readIndex(dataDir, offer.offerId);
  const ids = [...(index?.toolUseIds ?? []).filter((id) => id !== toolUseId), toolUseId];
  await write(heldIndexPath(dataDir, offer.offerId), {
    version: 1,
    at: now,
    toolUseIds: ids.slice(-MAX_HELD_PER_OFFER),
  } satisfies HeldIndex);
  if (offer.target !== undefined) {
    await write(heldTargetPath(dataDir, offer.target), {
      version: 1,
      at: now,
      toolUseId,
    } satisfies HeldTarget);
  }
}

/**
 * The same search or URL a call was held for in the last {@link EXPIRY_MS}
 * was let run natively: the model went back to its own tool, and the held
 * row reads `native`, so the mod draws the engine's row for the call that ran
 * in its place. A row already `routed` is left as it is.
 */
export async function markNative(
  dataDir: string,
  target: string,
  toolUseId: string,
  now = Date.now(),
): Promise<void> {
  const pointer = await readJson(heldTargetPath(dataDir, target));
  if (pointer?.version !== 1 || typeof pointer.toolUseId !== 'string') return;
  if (pointer.toolUseId === toolUseId) return;
  const path = heldRowPath(dataDir, pointer.toolUseId);
  const row = await readHeld(path);
  if (row === null || row.outcome !== 'held' || now - row.at > EXPIRY_MS) return;
  await write(path, { ...row, outcome: 'native', nativeToolUseId: toolUseId });
}

/**
 * The request tool ran this offer's id: every call held for it in the last
 * {@link EXPIRY_MS} reads `routed`, naming the request call that took it up
 * (`requestToolUseId`, the client's `claudecode/toolUseId`) so the mod draws
 * that call, and only that call, on the held row. A later call for the same
 * id finds the row already routed and leaves it. An older hold is a turn that
 * never made the call, and stays `held`.
 */
export async function markRouted(
  dataDir: string,
  offerId: string,
  now = Date.now(),
  requestToolUseId?: string,
): Promise<void> {
  const index = await readIndex(dataDir, offerId);
  if (index === null) return;
  for (const toolUseId of index.toolUseIds) {
    const path = heldRowPath(dataDir, toolUseId);
    const row = await readHeld(path);
    if (row === null || row.outcome !== 'held' || row.offerId !== offerId) continue;
    if (now - row.at > EXPIRY_MS) continue;
    await write(path, {
      ...row,
      outcome: 'routed',
      ...(requestToolUseId !== undefined ? { routedToolUseId: requestToolUseId } : {}),
    });
  }
}

/** A held row, or null for absent, damaged or not ours. */
export async function readHeld(path: string): Promise<HeldRow | null> {
  const row = await readJson(path);
  if (row === null || row.version !== 1 || typeof row.at !== 'number') return null;
  if (row.outcome !== 'held' && row.outcome !== 'routed' && row.outcome !== 'native') return null;
  if (typeof row.offerId !== 'string') return null;
  return row as unknown as HeldRow;
}

async function readIndex(dataDir: string, offerId: string): Promise<HeldIndex | null> {
  const row = await readJson(heldIndexPath(dataDir, offerId));
  if (row === null || row.version !== 1 || typeof row.at !== 'number') return null;
  const ids = Array.isArray(row.toolUseIds)
    ? row.toolUseIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { version: 1, at: row.at, toolUseIds: ids };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > MAX_RECORD_BYTES) return null;
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function write(path: string, body: HeldRow | HeldIndex | HeldTarget): Promise<boolean> {
  try {
    await writeFileAtomic(path, JSON.stringify(body), { mode: 0o600, dirMode: 0o700 });
    return true;
  } catch {
    return false;
  }
}
