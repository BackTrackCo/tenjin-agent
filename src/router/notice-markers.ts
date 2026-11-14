import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { hasCode } from '../lib/errno';
import type { UnlockReason } from '../lib/wallet-unlock';
import { WALLET_CLASS, walletClearedSentence } from './wallet-reasons';
import { sha256Hex } from '../lib/hash';
import { PRIVATE, sweep, writePrivate } from './store-files';

/**
 * WHAT A SESSION HAS ALREADY BEEN TOLD, on disk, because every hook leg is its
 * own process (or a fresh call into `tenjin mcp`) and none of them remembers
 * the last. Under `<dataDir>/router/notices`:
 *
 *   <sha32>              the old once-per-session marker ({@link firstNoticeFor})
 *   <sha32>-<sha8>       told this session this reason ({@link noticeFor})
 *   <sha32>.current      `${at}\n${why}`: the reason told last, or `cleared`
 *
 * `<sha32>` is the first 32 hex of sha256(session id) and `<sha8>` the first 8
 * of sha256(reason), so neither a session id nor a reason ever names a file.
 *
 * Once per (session, reason), with a clear line. A wallet that
 * goes from "no passphrase" to "wrong passphrase" is news twice; the same
 * reason on every prompt is news once. Once a paid call succeeds after a
 * wallet-class reason was told, the session hears paid routing recovered, once
 * ({@link noticeCleared}), and the reason's marker goes with it, so a relapse is
 * told again.
 *
 * Every file's FIRST line is the time it was written, and pruning reads only
 * that line, so old markers, new ones and `.current` all age out the same way:
 * a week after they were last written.
 *
 * Hook-safe: node, `./store-files`, `lib/errno` and the reason strings.
 */

/** How long a session's notice marker is kept. */
const NOTICE_KEEP_MS = 7 * 86_400_000;

/** What `.current` says once the reason told last has been cleared. */
const CLEARED = 'cleared';

/** Every reason {@link settleCurrent} clears: the unlock reasons and the
 *  unclassified fallback, all of which "Tenjin wallet unlocked." answers. */
const UNLOCK_CLASS: ReadonlyArray<UnlockReason | 'wallet_locked'> = [
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'unlock_timeout',
  'wallet_locked',
];

function noticesDir(dataDir: string): string {
  return join(dataDir, 'router', 'notices');
}

function sessionHash(sessionId: string): string {
  return sha256Hex(sessionId, 32);
}

function reasonMarker(dataDir: string, sessionId: string, why: string): string {
  const reason = sha256Hex(why, 8);
  return join(noticesDir(dataDir), `${sessionHash(sessionId)}-${reason}`);
}

function currentPath(dataDir: string, sessionId: string): string {
  return join(noticesDir(dataDir), `${sessionHash(sessionId)}.current`);
}

/** Record the reason told last (or `cleared`), atomically: two legs at once
 *  leave one whole answer, never a torn one. */
async function writeCurrent(
  dataDir: string,
  sessionId: string,
  now: number,
  why: string,
): Promise<void> {
  await writePrivate(currentPath(dataDir, sessionId), `${now}\n${why}`);
}

/**
 * 'tell' ONCE PER (SESSION, REASON): the first caller creates the marker,
 * records `why` as the reason told last, and gets 'tell'; every later caller
 * for the same pair gets 'quiet'. A new reason is a new marker, so it is told.
 * Rejects only on an I/O failure other than "already there"; callers treat
 * that as quiet.
 */
export async function noticeFor(
  dataDir: string,
  sessionId: string,
  why: string,
  now: number,
): Promise<'tell' | 'quiet'> {
  const created = await createExclusive(reasonMarker(dataDir, sessionId, why), String(now));
  if (!created) return 'quiet';
  await writeCurrent(dataDir, sessionId, now, why);
  await pruneNotices(dataDir, now);
  return 'tell';
}

/**
 * THE CLEAR LINE, only after a completed signed routing payment: paid routing
 * is working again when the reason told last was wallet-class, else null.
 * A free answer or background deposit alone must not call this.
 *
 * CLAIM BY UNLINK. Two legs can finish paid calls at once and both read the
 * same `.current`; only the one that takes that reason's marker away returns
 * the sentence, so it is said once. Removing the marker is also what lets the
 * reason be told again if the wallet relapses. The take is a rename to a name
 * of this caller's own, then a remove: two concurrent `unlink`s of one path
 * were both seen to succeed on macOS, and a rename of one source has exactly
 * one winner.
 */
export async function noticeCleared(
  dataDir: string,
  sessionId: string,
  now: number,
): Promise<string | null> {
  const text = await readFile(currentPath(dataDir, sessionId), 'utf8').catch(() => null);
  if (text === null) return null;
  const why = text.split('\n')[1] ?? '';
  if (!WALLET_CLASS.has(why)) return null;
  const marker = reasonMarker(dataDir, sessionId, why);
  const claimed = join(
    dirname(marker),
    `.${basename(marker)}.${randomBytes(6).toString('hex')}.claimed`,
  );
  try {
    await rename(marker, claimed);
  } catch {
    // Another leg claimed it (ENOENT), or it cannot be touched: say nothing.
    return null;
  }
  await rm(claimed, { force: true }).catch(() => undefined);
  await writeCurrent(dataDir, sessionId, now, CLEARED);
  return walletClearedSentence(why);
}

/**
 * The router's wallet news already said `Tenjin wallet unlocked.` on this
 * session's leg: mark the reason told last as cleared, so a later paid call
 * does not say it twice, and drop the markers of every unlock reason, so a
 * relapse is told again.
 */
export async function settleCurrent(
  dataDir: string,
  sessionId: string,
  now: number,
): Promise<void> {
  await writeCurrent(dataDir, sessionId, now, CLEARED);
  await Promise.all(
    UNLOCK_CLASS.map((why) =>
      rm(reasonMarker(dataDir, sessionId, why), { force: true }).catch(() => undefined),
    ),
  );
}

/**
 * TRUE ONCE PER SESSION: the first caller for a session id creates its marker
 * and gets true; every later one gets false. Each marker holds the time it was
 * made, and those older than a week go on the way past, so the directory does
 * not grow with every session ever run.
 */
export async function firstNoticeFor(
  dataDir: string,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const created = await createExclusive(
    join(noticesDir(dataDir), sessionHash(sessionId)),
    String(now),
  );
  if (created) await pruneNotices(dataDir, now);
  return created;
}

/**
 * Remove every notice file whose first line is not a time, or is a time more
 * than a week before `now`. Only the first line: `.current` carries its reason
 * on the second, and must age like any marker rather than look malformed.
 *
 * Skipped: a dot-file (another leg's `.current` mid-rename) and an empty file
 * (another leg's marker between its exclusive create and its write), so a prune
 * never pulls a file out from under a writer.
 */
async function pruneNotices(dataDir: string, now: number): Promise<void> {
  await sweep(noticesDir(dataDir), async (name, path) => {
    if (name.startsWith('.')) return false;
    const text = await readFile(path, 'utf8').catch(() => 'NaN');
    if (text.length === 0) return false;
    const at = Number(text.split('\n')[0]);
    return !Number.isFinite(at) || now - at > NOTICE_KEEP_MS;
  });
}

/** Create `path` holding `body`, only if it is not already there: true when
 *  this call made it, false on EEXIST, and any other failure rethrown. */
export async function createExclusive(path: string, body: string): Promise<boolean> {
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: PRIVATE.dirMode });
    const handle = await open(path, 'wx', PRIVATE.mode);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}
