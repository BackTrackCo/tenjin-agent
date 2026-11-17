import type { Writable } from 'node:stream';
import { hasCode } from './errno';

/** The bin's two output streams. */
export interface Stdio {
  stdout: Writable;
  stderr: Writable;
}

const STDIO: Stdio = { stdout: process.stdout, stderr: process.stderr };

/** The first output error that was not a closed pipe, for this process. */
let lost: { stream: keyof Stdio; err: unknown } | undefined;
/** A payment's authorization left this process ({@link notePaymentSent}). */
let paymentSent = false;
const guarded = new WeakSet<Writable>();

/**
 * A payment's authorization left this process: an output failure after it
 * says the authorization was sent and may have charged, and points to
 * `tenjin payments` to check. `runPay` calls it once the paid leg is sent.
 */
export function notePaymentSent(): void {
  paymentSent = true;
}

/**
 * THE BIN'S LAST STEP, IN THIS ORDER: take stdio's errors, run the command,
 * drain what it printed, exit. A write to a pipe whose reader went away fails
 * a tick later, as an `error` event on the stream, and with no listener Node
 * crashes on it: exit 1 instead of the command's own code. The listeners go
 * on before the command runs, so no write it makes can crash the process,
 * however early its reader left; {@link flushStdio} then waits out what is
 * still queued.
 *
 * The command keeps its own code, unless output was lost: see
 * {@link exitCodeAfter}. The exit is explicit: a process left to end on its
 * own keeps `tenjin mcp` alive after SIGTERM while its stdin stays open.
 */
export async function exitAfter(run: () => Promise<number>, stdio: Stdio = STDIO): Promise<never> {
  guardStdio(stdio);
  const code = await run();
  await flushStdio(stdio);
  process.exit(await exitCodeAfter(code, stdio));
}

/**
 * A STREAM'S ERRORS, TAKEN for the rest of the process. A reader that went
 * away (EPIPE) leaves nothing to write to: never a crash, and never a
 * failure, so the command keeps its status. Any other error (a full disk, a
 * file at its size limit) lost output the reader needed, and is kept for
 * {@link exitCodeAfter}. Installed once per stream.
 */
export function guardStdio(stdio: Stdio = STDIO): void {
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = stdio[name];
    if (guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on('error', (err: unknown) => noteWriteError(name, err));
  }
}

function noteWriteError(stream: keyof Stdio, err: unknown): void {
  if (hasCode(err, 'EPIPE')) return;
  lost ??= { stream, err };
}

/**
 * THE EXIT CODE, ONCE OUTPUT IS DRAINED. With nothing lost, the command's
 * own. With output lost, it is said on stderr when stderr is not the stream
 * that failed, and the exit is nonzero: the command's own failing code, else
 * 4 after a payment (a failure after an approved spend) and 1 otherwise.
 * After a payment the line says the authorization was sent and may have
 * charged, so the reader checks `tenjin payments` before paying again. It
 * claims no charge and no saved record, since neither is known here.
 */
export async function exitCodeAfter(code: number, stdio: Stdio = STDIO): Promise<number> {
  if (lost === undefined) return code;
  if (lost.stream === 'stdout') {
    await report(stdio.stderr, lostOutputLine(lost.err));
  }
  return code !== 0 ? code : paymentSent ? 4 : 1;
}

/** The line said on stderr; a system error's message carries its code. */
function lostOutputLine(err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return paymentSent
    ? `tenjin: the output could not be written (${why}) after a payment authorization was sent, so you may have been charged. Check \`tenjin payments\` before paying again.\n`
    : `tenjin: the output could not be written (${why}).\n`;
}

async function report(stream: Writable, line: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return;
  try {
    stream.write(line);
  } catch {
    return;
  }
  await flushed(stream, 'stderr');
}

/**
 * EVERY BYTE WRITTEN, THEN EXIT. On a pipe Node writes stdout asynchronously,
 * and `process.exit` ends the process at once: whatever the reader had not
 * taken yet (past the pipe's 64 KB) was dropped, which cut printed `tenjin
 * pay` bodies off at 426 KB and 557 KB. An empty write's callback runs only
 * after every write queued before it has gone to the OS, so waiting on it on
 * each stream loses nothing. A stream already closed has nothing left to wait
 * for. A write that fails while it drains is judged as {@link guardStdio}
 * judges one: a reader that went away is taken, and any other error is kept,
 * so it fails the exit too. An error before this runs is the guard's to take:
 * the bin installs it before the command.
 *
 * It waits as long as the reader takes, as a process that ends on its own
 * would: a reader that never reads holds the exit.
 */
export async function flushStdio(stdio: Stdio = STDIO): Promise<void> {
  await Promise.all([flushed(stdio.stdout, 'stdout'), flushed(stdio.stderr, 'stderr')]);
}

function flushed(stream: Writable, name: keyof Stdio): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    const failed = (err: unknown): void => {
      // A stream destroyed under a queued write fails that write with
      // ERR_STREAM_DESTROYED; its cause came as the stream's own error event.
      if (!hasCode(err, 'ERR_STREAM_DESTROYED')) noteWriteError(name, err);
      resolve();
    };
    stream.once('error', failed);
    try {
      stream.write('', (err?: Error | null) => (err ? failed(err) : resolve()));
    } catch (err) {
      failed(err);
    }
  });
}
