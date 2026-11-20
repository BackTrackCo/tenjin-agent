import { appendFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { withHeldLock } from '../held-lock';

/**
 * One stress worker. It takes the lock in a loop and, inside, appends `E <pid>` to one shared
 * append-only log, yields a turn, and appends `X <pid>` before it releases. The parent reads the
 * log: an `E` while another holder's `E` has no `X` (or kill line) is an overlap, and no
 * interleaving can hide it. With STRESS_BROKEN set (a probability), that share of the rounds
 * skips the lock: the control that proves the detector sees a broken lock.
 */
const [lock, log] = process.argv.slice(2) as [string, string];
const broken = Number(process.env.STRESS_BROKEN ?? 0);
const counts = { pid: process.pid, rounds: 0, timeouts: 0, errors: 0 };
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

for (;;) {
  try {
    if (broken > 0 && Math.random() < broken) await critical();
    else await withHeldLock(lock, critical, { timeoutMs: 3000, retryMs: 1 });
  } catch (error) {
    if (error instanceof Error && error.name === 'LockTimeoutError') counts.timeouts++;
    else counts.errors++;
  }
}
