import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { withHeldLock } from '../held-lock';

/**
 * One stress worker: it takes the lock in a loop, and inside makes a marker appear whole (a temp
 * file linked to the marker name). A marker that is already there while this worker holds the
 * lock is an overlap, unless the process that made it is gone, which a second look 1.5 s later
 * settles (a killed holder leaves its marker). Counts go to stdout as JSON lines.
 */
const [lock, marker] = process.argv.slice(2) as [string, string];
const counts = { pid: process.pid, rounds: 0, overlaps: 0, timeouts: 0, errors: 0 };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const save = () => process.stdout.write(`${JSON.stringify(counts)}\n`);
setInterval(save, 200).unref();
process.on('SIGTERM', () => {
  save();
  process.exit(0);
});

const tmp = `${marker}.${process.pid}`;
for (;;) {
  try {
    await withHeldLock(
      lock,
      async () => {
        writeFileSync(tmp, String(process.pid));
        try {
          linkSync(tmp, marker);
        } catch {
          await delay(1500);
          let other = Number.NaN;
          try {
            other = Number(readFileSync(marker, 'utf8'));
          } catch {
            // Gone meanwhile: its holder finished.
          }
          if (Number.isFinite(other) && alive(other)) counts.overlaps++;
          try {
            unlinkSync(marker);
            linkSync(tmp, marker);
          } catch {
            // Another worker already replaced it.
          }
        }
        await yieldTurn();
        try {
          unlinkSync(marker);
        } catch {
          // Taken away by a worker that judged it stale.
        }
        unlinkSync(tmp);
        counts.rounds++;
      },
      { timeoutMs: 3000, retryMs: 1 },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'LockTimeoutError') counts.timeouts++;
    else counts.errors++;
  }
}
