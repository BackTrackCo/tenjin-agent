import { openLoopDb, type LoopDb } from '../hooks/store';
import { CliError } from './errors';

/**
 * How every CLI verb reaches `loop.db`.
 *
 * The daemon holds its handle for the life of the process; a command opens the
 * file, runs its statements and closes. Two differences from the daemon's open,
 * and only two. The busy timeout is short, because a command that cannot get the
 * write lock in a quarter of a second is better off saying so than blocking an
 * agent's turn behind the daemon's fsync. And it NEVER REBUILDS: `openLoopDb`
 * deletes a file whose shape is not this build's, which is the right answer for
 * the process that owns the ledger and the wrong one for a CLI that may be a
 * different build entirely (two worktrees on one laptop). A mismatch here is an
 * error naming the way out.
 *
 * There is no wrapper type and no `run()` that answers false: a statement that
 * fails throws, and the throw reaches the caller as a {@link CliError}. The store
 * this replaced swallowed those, and a caller then stamped a row as synced with
 * no link to show for it.
 */

/** Short enough that a command never blocks a turn on the daemon's write lock,
 *  long enough to cover one (02-redesign.md §10). */
const CLI_BUSY_TIMEOUT_MS = 250;

/** Open `loop.db` as a command: no rebuild, and any failure is a `CliError`. */
export function openLoopDbForCli(dataDir: string): LoopDb {
  try {
    return openLoopDb(dataDir, { busyTimeoutMs: CLI_BUSY_TIMEOUT_MS, rebuild: false });
  } catch (err) {
    throw new CliError('INTERNAL', err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
}

/** Open, run `fn`, close. The close is the point: a command that threw mid-way
 *  still releases the file, so the next one is not met by a stale lock. */
export function withLoopDb<T>(dataDir: string, fn: (db: LoopDb) => T): T {
  const db = openLoopDbForCli(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
