import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { holdLock, holdLockWith } from '../held-lock';
import { loadSqlite, sqliteAttempt } from '../held-lock-sqlite';

/**
 * A child process for the lock tests. `holder <lock> hold` takes the lock, prints `held`, and
 * releases and exits at the first line on stdin. `holder <lock> probe` makes one zero-wait
 * attempt and prints `free` or `held`. `holder <lock> forget` takes the lock, drops its release,
 * forces garbage collection, prints `held` and waits for a line on stdin. A third argument,
 * `sqlite`, takes the Linux primitive on any platform that has node:sqlite.
 */
const [lockPath, mode = 'hold', primitive] = process.argv.slice(2);
if (lockPath === undefined) throw new Error('lock path needed');

const take = (timeoutMs: number) =>
  primitive === 'sqlite'
    ? holdLockWith((held) => sqliteAttempt(held, loadSqlite()!), lockPath, { timeoutMs })
    : holdLock(lockPath, { timeoutMs });

if (mode === 'probe') {
  try {
    (await take(0))();
    process.stdout.write('free\n');
  } catch (error) {
    process.stdout.write(
      error instanceof Error && error.name === 'LockTimeoutError' ? 'held\n' : `error ${error}\n`,
    );
  }
} else if (mode === 'forget') {
  await take(3000);
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  for (let round = 0; round < 5; round++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.stdout.write('held\n');
  process.stdin.once('data', () => process.exit(0));
} else {
  const release = await take(3000);
  process.stdout.write('held\n');
  process.stdin.once('data', () => {
    release();
    process.exit(0);
  });
}
