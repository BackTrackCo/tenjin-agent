import { holdLock } from '../held-lock';

/**
 * A child process for the lock tests. `holder <lock> hold` takes the lock, prints `held`, and
 * releases and exits at the first line on stdin. `holder <lock> probe` makes one zero-wait
 * attempt and prints `free` or `held`.
 */
const [lockPath, mode = 'hold'] = process.argv.slice(2);
if (lockPath === undefined) throw new Error('lock path needed');

if (mode === 'probe') {
  try {
    (await holdLock(lockPath, { timeoutMs: 0 }))();
    process.stdout.write('free\n');
  } catch (error) {
    process.stdout.write(
      error instanceof Error && error.name === 'LockTimeoutError' ? 'held\n' : `error ${error}\n`,
    );
  }
} else {
  const release = await holdLock(lockPath, { timeoutMs: 3000 });
  process.stdout.write('held\n');
  process.stdin.once('data', () => {
    release();
    process.exit(0);
  });
}
