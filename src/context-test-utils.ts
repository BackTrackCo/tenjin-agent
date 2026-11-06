import type { CommandContext, GlobalFlags } from './context';
import type { Io } from './lib/output';

/** A test's command output: the streams, and what each was written, as text. */
export interface CapturedIo {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

/** An Io whose stdout and stderr keep everything written to them. */
export function captureIo(isTTY = false): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    io: { stdout: mk(out), stderr: mk(err), isTTY },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

export type TestCtxOptions = Partial<GlobalFlags> & { isTTY?: boolean };

/**
 * A CommandContext over `dataDir` with its output captured: JSON mode, a 5 s
 * timeout and no TTY, unless `opts` says otherwise.
 */
export function captureCtx(
  dataDir: string,
  opts: TestCtxOptions = {},
): Omit<CapturedIo, 'io'> & { ctx: CommandContext } {
  const { isTTY = false, ...flags } = opts;
  const { io, stdout, stderr } = captureIo(isTTY);
  return { ctx: { flags: { json: true, timeout: 5000, ...flags }, dataDir, io }, stdout, stderr };
}

/** {@link captureCtx}'s context alone, for a test that never reads the output. */
export function testCtx(dataDir: string, opts: TestCtxOptions = {}): CommandContext {
  return captureCtx(dataDir, opts).ctx;
}
