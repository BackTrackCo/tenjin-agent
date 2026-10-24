import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { parseHookDecision, type HookDecision } from './decision';
import { DECIDED_PREFIX, sessionDir } from './progress';

/**
 * ONE SEARCH, ONE DECISION. When automatic use is on, the swap asks the router
 * about a native search or fetch before the host's pre-call hook runs. If it
 * hands the call back (no input to run in place, a provider outside the
 * automatic scope, a price over the limit), the pre-call hook then offers from
 * the same decision instead of asking, and paying for, a second one. The
 * decision is kept here, under the session and the harness's own
 * `tool_use_id`, with the exact search or URL it was made for; a different
 * target, a stale record or one that does not parse is read as absent.
 *
 * Hook-safe: node, zod (through `decision.ts`) and `lib/atomic-json` only.
 * Every failure is "absent": a lost record costs one more decision, never a
 * wrong one.
 */

/** Long enough for the host to run its pre-call hook after the swap answered. */
export const DECIDED_TTL_MS = 60_000;

/** The router's answer runs to a few hundred kilobytes at most. */
const MAX_DECIDED_BYTES = 1024 * 1024;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function decidedPath(dataDir: string, sessionId: string, toolUseId: string): string {
  return join(sessionDir(dataDir, sessionId), `${DECIDED_PREFIX}${digest(toolUseId)}.json`);
}

/** Keep the decision the swap made for this call: null when the router gave none. */
export async function keepDecided(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  target: string,
  decision: HookDecision | null,
  now = Date.now(),
): Promise<void> {
  try {
    await writeFileAtomic(
      decidedPath(dataDir, sessionId, toolUseId),
      JSON.stringify({ version: 1, at: now, target, decision }),
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch {
    // Lost: the pre-call hook decides again.
  }
}

/**
 * The decision kept for this call and target, taken once: the record is
 * removed as it is read, so a retry of the same call is decided afresh.
 * `undefined` when none is kept; `null` is a kept "the router gave none".
 */
export async function takeDecided(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  target: string,
  now = Date.now(),
): Promise<{ decision: HookDecision | null } | undefined> {
  const path = decidedPath(dataDir, sessionId, toolUseId);
  const row = await readBounded(path);
  if (row === undefined) return undefined;
  await rm(path, { force: true }).catch(() => undefined);
  if (row.version !== 1 || typeof row.at !== 'number' || row.target !== target) return undefined;
  if (now - row.at > DECIDED_TTL_MS || row.at > now + DECIDED_TTL_MS) return undefined;
  if (row.decision === null) return { decision: null };
  const decision = parseHookDecision(row.decision);
  return decision === undefined ? undefined : { decision };
}

/** One bounded JSON object, never through a symlink planted under the data dir. */
async function readBounded(path: string): Promise<Record<string, unknown> | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return undefined;
  try {
    if ((await file.stat()).size > MAX_DECIDED_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await file.readFile('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }
}
