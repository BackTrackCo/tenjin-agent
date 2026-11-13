import type { Writable } from 'node:stream';

const STDIO: readonly Writable[] = [process.stdout, process.stderr];

/**
 * THE BIN'S LAST STEP, IN THIS ORDER: take stdio's errors, run the command,
 * drain what it printed, exit with its code. A write to a pipe whose reader
 * went away fails a tick later, as an `error` event on the stream, and with
 * no listener Node crashes on it: exit 1 instead of the command's own code.
 * The listeners go on before the command runs, so no write it makes can
 * crash the process, however early its reader left; {@link flushStdio} then
 * waits out what is still queued.
 */
export async function exitAfter(
  run: () => Promise<number>,
  streams: readonly Writable[] = STDIO,
): Promise<never> {
  guardStdio(streams);
  const code = await run();
  await flushStdio(streams);
  process.exit(code);
}

/**
 * A STREAM'S ERRORS, TAKEN for the rest of the process: a reader that went
 * away (EPIPE) leaves nothing to write to, and is never a crash. Installed
 * once per stream.
 */
export function guardStdio(streams: readonly Writable[] = STDIO): void {
  for (const stream of streams) {
    if (!stream.listeners('error').includes(ignore)) stream.on('error', ignore);
  }
}

function ignore(): void {}

/**
 * EVERY BYTE WRITTEN, THEN EXIT. On a pipe Node writes stdout asynchronously,
 * and `process.exit` ends the process at once: whatever the reader had not
 * taken yet (past the pipe's 64 KB) was dropped, which cut printed `tenjin
 * pay` bodies off at 426 KB and 557 KB. An empty write's callback runs only
 * after every write queued before it has gone to the OS, so waiting on it on
 * each stream loses nothing. A stream already closed, or one whose reader went
 * away (EPIPE), has nothing left to wait for; its error is taken here too, so
 * it never becomes a crash on the way out. An error before this runs is
 * {@link guardStdio}'s to take: the bin installs it before the command.
 *
 * It waits as long as the reader takes, as a process that ends on its own
 * would: a reader that never reads holds the exit.
 */
export async function flushStdio(streams: readonly Writable[] = STDIO): Promise<void> {
  await Promise.all(streams.map(flushed));
}

function flushed(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    stream.on('error', () => resolve());
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}
