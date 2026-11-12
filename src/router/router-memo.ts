import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomicExclusive } from '../lib/atomic-json';
import { hasCode } from '../lib/errno';
import { sha256Hex } from '../lib/hash';
import { PRIVATE, writePrivate } from './store-files';

/**
 * ONE MEMO FOR "DO NOT ASK THE ROUTER YET", per machine and per router origin,
 * in the data dir, so every hook leg and every `tenjin mcp` process reads the
 * same answer:
 *
 * - `unreachable`: a routing leg's call could not reach the router (DNS, TLS,
 *   a refused connection, a proxy refusing the tunnel; see `isUnreachable`). For
 *   {@link UNREACHABLE_BACKOFF_MS} every leg skips the router and the native
 *   tool runs at once, instead of each prompt and search waiting out the gate.
 *   Doctor's probe ends it early when it reaches the router.
 * - `topping-up`: a `tenjin mcp` process is topping up the wallet's routing
 *   channel in the background ({@link TOPPING_UP_MEMO_MS}), so another one on
 *   the same wallet does not send a second deposit. One memo per wallet, which
 *   one process at a time claims ({@link claimRouterMemo}).
 * - `warm-absent`: the router answered the background top-up's `warm` call
 *   with a 2xx that is not the `warm` answer, or a 3xx or 4xx other than a
 *   402 or 429 (an older server answers 400), so it has no `warm` form. For
 *   {@link WARM_ABSENT_MS} a deposit rides the next paid call, as it did
 *   before the form existed. A 402, 429, 5xx or no answer backs off instead.
 *
 * A memo is a file written atomically and read with the clock: one older than
 * its window, or dated in the future, reads as absent, so nothing cleans up
 * after it. An unreadable file reads as absent too: the cost of a lost memo is
 * one more call to the router.
 */
export type RouterMemoKind = 'unreachable' | 'topping-up' | 'warm-absent';

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
/** How long another process's top-up holds this one's off at most: the
 *  top-up's own budget (`TOP_UP_TIMEOUT_MS`, 15 s), a deposit still out after
 *  it (`DETACHED_CEILING_MS`, 15 s) and some. Its holder ends it sooner. */
export const TOPPING_UP_MEMO_MS = 35_000;
/** How long a router without the `warm` form gets deposits on the next paid
 *  call instead, before the top-up tries `warm` again. */
export const WARM_ABSENT_MS = 60 * 60_000;

/** `scope` gives each wallet a memo of its own, under the same origin. */
function memoPath(dataDir: string, kind: RouterMemoKind, baseUrl: string, scope?: string): string {
  const origin = new URL(baseUrl).origin;
  const key = sha256Hex(scope === undefined ? origin : `${origin}\n${scope}`, 16);
  return join(dataDir, 'router-memo', `${kind}-${key}.json`);
}

/** The memo in the file, whatever its window, or null. Never throws, not
 *  even on a base URL that does not parse. */
async function readMemoFile(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  scope?: string,
): Promise<RouterMemo | null> {
  try {
    const raw = JSON.parse(
      await readFile(memoPath(dataDir, kind, baseUrl, scope), 'utf8'),
    ) as unknown;
    if (raw === null || typeof raw !== 'object') return null;
    const { at, until, detail } = raw as Record<string, unknown>;
    if (typeof at !== 'number' || typeof until !== 'number') return null;
    return { at, until, ...(typeof detail === 'string' ? { detail } : {}) };
  } catch {
    return null;
  }
}

/** The memo in force at `now`, or null. Never throws. */
export async function readRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  now: number,
  scope?: string,
): Promise<RouterMemo | null> {
  const memo = await readMemoFile(dataDir, kind, baseUrl, scope);
  return memo === null || memo.at > now || memo.until <= now ? null : memo;
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
    await writePrivate(memoPath(dataDir, kind, baseUrl), `${JSON.stringify(body)}\n`);
  } catch {
    // Best effort: a memo that did not land costs one more call.
  }
}

/** Ends a memo before its window does. Never throws. */
export async function clearRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  scope?: string,
): Promise<void> {
  try {
    await rm(memoPath(dataDir, kind, baseUrl, scope), { force: true });
  } catch {
    // Best effort: the window ends it anyway.
  }
}

/**
 * A MEMO ONLY ONE PROCESS HOLDS. It is created whole and exclusively, so of
 * two processes claiming at once exactly one wins. One past its window, or
 * unreadable, was left by a process that died holding it: it is removed and
 * claimed once more. One dated after this claim's `now` is a contender's that
 * read the clock a moment later and is held, unless it is a whole window
 * ahead (the clock went back). The claim's token, its `detail`, is what
 * {@link releaseRouterMemo} checks, so a holder never ends another's claim.
 * The token, or null when another process holds it. Never throws: a claim the
 * file system refuses outright counts as this call's, as before claims existed.
 */
export async function claimRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  memo: { now: number; ttlMs: number; scope?: string },
): Promise<string | null> {
  const path = memoPath(dataDir, kind, baseUrl, memo.scope);
  const token = randomBytes(8).toString('hex');
  const body: RouterMemo = { at: memo.now, until: memo.now + memo.ttlMs, detail: token };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFileAtomicExclusive(path, `${JSON.stringify(body)}\n`, PRIVATE);
      return token;
    } catch (err) {
      if (!hasCode(err, 'EEXIST')) return token;
    }
    const held = await readMemoFile(dataDir, kind, baseUrl, memo.scope);
    if (held !== null && held.until > memo.now && held.at <= memo.now + memo.ttlMs) return null;
    await rm(path, { force: true }).catch(() => undefined);
  }
  return null;
}

/** Ends this claim, unless another process's has replaced it. Never throws. */
export async function releaseRouterMemo(
  dataDir: string,
  kind: RouterMemoKind,
  baseUrl: string,
  claim: { token: string; now: number; scope?: string },
): Promise<void> {
  const held = await readRouterMemo(dataDir, kind, baseUrl, claim.now, claim.scope);
  if (held?.detail === claim.token) await clearRouterMemo(dataDir, kind, baseUrl, claim.scope);
}
