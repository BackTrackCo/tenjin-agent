import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';

/**
 * ONE MEMO FOR "DO NOT ASK THE ROUTER YET", per machine and per router origin,
 * in the data dir, so every hook leg and every `tenjin mcp` process reads the
 * same answer. Two facts use it:
 *
 * - `unreachable`: a routing leg's call could not reach the router (DNS, TLS,
 *   a refused connection, a proxy refusing the tunnel; see `isUnreachable`). For
 *   {@link UNREACHABLE_BACKOFF_MS} every leg skips the router and the native
 *   tool runs at once, instead of each prompt and search waiting out the gate.
 *   Doctor's probe ends it early when it reaches the router.
 * - `paid-path-absent`: the router answered no paid path (the fee is off), so
 *   calls take the free path without asking for an hour, or until the free
 *   path answers `fee_required`.
 *
 * A memo is a file written atomically and read with the clock: one older than
 * its window, or dated in the future, reads as absent, so nothing cleans up
 * after it. An unreadable file reads as absent too: the cost of a lost memo is
 * one more call to the router.
 */
export type RouterMemoKind = 'unreachable' | 'paid-path-absent';

export interface RouterMemo {
  /** When it was written, in epoch ms. */
  at: number;
  /** When it ends, in epoch ms. */
  until: number;
  /** What happened, for doctor. */
  detail?: string;
}

/** How long routing legs skip a router that did not answer. */
export const UNREACHABLE_BACKOFF_MS = 60_000;

function memoPath(dataDir: string, kind: RouterMemoKind, baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  const key = createHash('sha256').update(origin).digest('hex').slice(0, 16);
  return join(dataDir, 'router-memo', `${kind}-${key}.json`);
}

/** The memo in force at `now`, or null. Never throws. */
export async function readRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  now: number,
): Promise<RouterMemo | null> {
  try {
    const raw = JSON.parse(await readFile(memoPath(dataDir, kind, baseUrl), 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object') return null;
    const { at, until, detail } = raw as Record<string, unknown>;
    if (typeof at !== 'number' || typeof until !== 'number') return null;
    if (at > now || until <= now) return null;
    return { at, until, ...(typeof detail === 'string' ? { detail } : {}) };
  } catch {
    return null;
  }
}

/** Starts a memo of `ttlMs` from `now`. Never throws. */
export async function writeRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  memo: { now: number; ttlMs: number; detail?: string },
): Promise<void> {
  const body: RouterMemo = {
    at: memo.now,
    until: memo.now + memo.ttlMs,
    ...(memo.detail !== undefined ? { detail: memo.detail.slice(0, 300) } : {}),
  };
  try {
    await writeFileAtomic(memoPath(dataDir, kind, baseUrl), `${JSON.stringify(body)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // Best effort: a memo that did not land costs one more call.
  }
}

/** Ends a memo before its window does. Never throws. */
export async function clearRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
): Promise<void> {
  try {
    await rm(memoPath(dataDir, kind, baseUrl), { force: true });
  } catch {
    // Best effort: the window ends it anyway.
  }
}
