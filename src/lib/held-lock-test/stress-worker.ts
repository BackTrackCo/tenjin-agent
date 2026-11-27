import { appendFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { discardHeldLock, holdLockWith, withHeldLock, type AttemptFactory } from '../held-lock';
import { loadSqlite, sqliteAttempt } from '../held-lock-sqlite';

/**
 * One stress worker. It takes the lock in a loop and, inside, appends `E <pid>` to one shared
 * append-only log, yields a turn, and appends `X <pid>` before it releases. The parent reads the
 * log: an `E` while another holder's `E` has no `X` (or kill line) is an overlap, and no
 * interleaving can hide it. With STRESS_BROKEN set (a probability), that share of the rounds
 * skips the lock: the control that proves the detector sees a broken lock. STRESS_PRIMITIVE=sqlite
 * takes the Linux primitive on any platform that has node:sqlite. STRESS_DISCARD (a probability)
 * makes that share of the rounds end with a cleanup that deletes the lock file while it holds the
 * lock, as the job sweep does: a lock file that goes and comes back must never let two in.
 */
const [lock, log] = process.argv.slice(2) as [string, string];
const broken = Number(process.env.STRESS_BROKEN ?? 0);
const counts = { pid: process.pid, rounds: 0, timeouts: 0, errors: 0, broken: 0 };
const save = () => process.stdout.write(`${JSON.stringify(counts)}\n`);
setInterval(save, 200).unref();
process.on('SIGTERM', () => {
  save();
  process.exit(0);
});

const critical = async () => {
  appendFileSync(log, `E ${process.pid}\n`);
  // Long enough that a second holder arriving meanwhile is seen, even on one busy core.
  await pause(1);
  appendFileSync(log, `X ${process.pid}\n`);
  counts.rounds++;
};

const options = { timeoutMs: 3000, retryMs: 1 };
const sqlite = process.env.STRESS_PRIMITIVE === 'sqlite';
const make: AttemptFactory | undefined = sqlite
  ? (held) => sqliteAttempt(held, loadSqlite()!)
  : undefined;
const discard = Number(process.env.STRESS_DISCARD ?? 0);
const locked = async () => {
  if (!make) await withHeldLock(lock, critical, options);
  else {
    const release = await holdLockWith(make, lock, options);
    try {
      await critical();
    } finally {
      release();
    }
  }
  if (discard > 0 && Math.random() < discard) await discardHeldLock(lock, make);
};

for (;;) {
  try {
    if (broken > 0 && Math.random() < broken) {
      counts.broken++;
      await critical();
    } else await locked();
  } catch (error) {
    if (error instanceof Error && error.name === 'LockTimeoutError') counts.timeouts++;
    else counts.errors++;
  }
}
