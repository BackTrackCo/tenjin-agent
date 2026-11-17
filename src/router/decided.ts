import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../lib/hash';
import { parseHookResponse, type HookResponse } from './decision';
import { DECIDED_PREFIX, sessionDir } from './progress';
import { readJsonFile, writePrivate } from './store-files';

/**
 * ONE SEARCH, ONE DECISION. With automatic use on, the swap asks the router
 * about a native search or fetch before the host's pre-call hook runs. When it
 * hands the call back (no `bound` input, a pick outside the automatic scope, a
 * price over the limit), the pre-call hook offers from that same answer
 * instead of asking, and paying for, a second one. The answer is kept here,
 * under the session and the harness's own `tool_use_id`, with the exact
 * search or URL it was made for, its settings hash included; a different
 * target, a stale record or one that does not parse is read as absent.
 *
 * Hook-safe: node, zod (through `decision.ts`) and `store-files.ts` only.
 * Every failure is "absent": a lost record costs one more decision, never a
 * wrong one.
 */

/** Long enough for the host to run its pre-call hook after the swap answered. */
const DECIDED_TTL_MS = 60_000;

/** The router's answer runs to a few hundred kilobytes at most. */
const MAX_DECIDED_BYTES = 1024 * 1024;

function decidedPath(dataDir: string, sessionId: string, toolUseId: string): string {
  return join(sessionDir(dataDir, sessionId), `${DECIDED_PREFIX}${sha256Hex(toolUseId)}.json`);
}

/** What the swap decided for one call. */
export interface Decided {
  /** The router's whole answer: null when it gave none. */
  answer: HookResponse | null;
  /** Why the routing fee was not paid, when it was not (`fee_required`, ...). */
  unpaid?: string;
}

/** Keep the answer the swap got for this call. */
export async function keepDecided(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  target: string,
  { answer, unpaid }: Decided,
  now = Date.now(),
): Promise<void> {
  try {
    await writePrivate(
      decidedPath(dataDir, sessionId, toolUseId),
      JSON.stringify({ version: 1, at: now, target, answer, unpaid }),
    );
  } catch {
    // Lost: the pre-call hook decides again.
  }
}

/**
 * The answer kept for this call and target, taken once: the record is removed
 * as it is read, so a retry of the same call is decided afresh. `undefined`
 * when none is kept; an `answer` of null is a kept "the router gave none".
 */
export async function takeDecided(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  target: string,
  now = Date.now(),
): Promise<Decided | undefined> {
  const path = decidedPath(dataDir, sessionId, toolUseId);
  const row = await readJsonFile(path, MAX_DECIDED_BYTES);
  if (row === null) return undefined;
  await rm(path, { force: true }).catch(() => undefined);
  if (row.version !== 1 || typeof row.at !== 'number' || row.target !== target) return undefined;
  if (now - row.at > DECIDED_TTL_MS || row.at > now + DECIDED_TTL_MS) return undefined;
  const unpaid = typeof row.unpaid === 'string' ? { unpaid: row.unpaid } : {};
  if (row.answer === null) return { answer: null, ...unpaid };
  const answer = parseHookResponse(row.answer);
  return answer === undefined ? undefined : { answer, ...unpaid };
}
