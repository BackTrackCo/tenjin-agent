import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext, GlobalFlags } from '../context';
import type { Io } from '../lib/output';

/**
 * What a command test needs before it can call a run function: a throwaway data
 * dir, an `Io` whose streams go nowhere (or into an array a test can read back),
 * and the `CommandContext` around both. Shared because two dozen command suites
 * hand-rolled the same four objects, and the next copy of them is where they
 * start to disagree. Not bundled into dist (nothing in the entry graph imports
 * it), same pattern as `lib/read-test-utils.ts` and `hooks/arms/test-support.ts`.
 *
 * Every helper returns a FRESH object. A shared mutable fixture is how one test's
 * flag override leaks into the next one's assertion.
 */

const dirs: string[] = [];

/** A temp directory, remembered for `cleanupTempDirs`. Sync, so no `await`. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** For an `afterEach`: removes every dir this file made. */
export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A writable stream that accepts and discards everything. */
export function sinkStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

/** A writable stream that appends every chunk to `parts`. */
export function capturingStream(parts: string[]): NodeJS.WritableStream {
  return {
    write: (chunk: string | Uint8Array) => {
      parts.push(chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

/** Both streams discarded: for the tests that assert on the result, not the render. */
export function sinkIo(isTTY = false): Io {
  return { stdout: sinkStream(), stderr: sinkStream(), isTTY };
}

export interface CapturedIo {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

/** Both streams recorded, each readable as one joined string. */
export function capturingIo(isTTY = false): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: capturingStream(out), stderr: capturingStream(err), isTTY },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

export interface CtxOptions {
  dataDir: string;
  /** Merged over `{ json: false, timeout: 5000 }`. */
  flags?: Partial<GlobalFlags>;
  /** Defaults to a sink pair; pass `capturingIo().io` to read the render back. */
  io?: Io;
  /** Only consulted when `io` is not given. */
  isTTY?: boolean;
}

export function commandContext(opts: CtxOptions): CommandContext {
  return {
    flags: { json: false, timeout: 5000, ...opts.flags },
    dataDir: opts.dataDir,
    io: opts.io ?? sinkIo(opts.isTTY ?? false),
  };
}

/** The JSON reply shape every command's fetch stub hands back. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
