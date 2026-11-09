import type { Writable } from 'node:stream';

/**
 * EVERY BYTE WRITTEN, THEN EXIT. On a pipe Node writes stdout asynchronously,
 * and `process.exit` ends the process at once: whatever the reader had not
 * taken yet (past the pipe's 64 KB) was dropped, which cut printed `tenjin
 * pay` bodies off at 426 KB and 557 KB. An empty write's callback runs only
 * after every write queued before it has gone to the OS, so waiting on it on
 * each stream loses nothing. A stream already closed, or one whose reader went
 * away (EPIPE), has nothing left to wait for; its error is taken here, so it
 * never becomes a crash on the way out.
 *
 * It waits as long as the reader takes, as a process that ends on its own
 * would: a reader that never reads holds the exit.
 */
export async function flushStdio(
  streams: readonly Writable[] = [process.stdout, process.stderr],
): Promise<void> {
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
