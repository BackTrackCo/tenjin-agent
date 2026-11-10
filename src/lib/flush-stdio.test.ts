import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE 64 KB CUT. `tenjin pay` printed a 557 KB body into a pipe and exited
 * before the pipe drained, so the reader got the first 64 KB. These run the
 * real module in a child process whose stdout is a pipe, as an agent's shell
 * reads it, and count what arrives.
 */

const MODULE = pathToFileURL(fileURLToPath(new URL('./flush-stdio.ts', import.meta.url))).href;
/** Node strips types by default from 22.18 and 23.6; older builds need the flag. */
const STRIP = (process.features as { typescript?: unknown }).typescript
  ? []
  : ['--experimental-strip-types'];

/**
 * Runs `script` with stdout piped here. With `closeFirst`, this side closes
 * its end of the pipe, then tells the child to go on stdin: every write the
 * child makes after that fails with EPIPE.
 */
function run(
  script: string,
  opts: { closeFirst?: boolean } = {},
): Promise<{ code: number | null; bytes: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...STRIP, '--no-warnings', '--input-type=module', '-e', script],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, bytes, stderr }));
    if (opts.closeFirst === true) child.stdout.destroy();
    child.stdin.end('go');
  });
}

/** The child's script: on the go byte, write `size` bytes, flush, exit `code`. */
const writeThenExit = (size: number, code: number): string =>
  `import { flushStdio } from ${JSON.stringify(MODULE)};
   process.stdin.once('data', async () => {
     process.stdout.write('x'.repeat(${size}));
     await flushStdio();
     process.exit(${code});
   });`;

/**
 * The bin's order (src/index.ts): the helper is loaded and its guard is on
 * before the command runs. The command writes into a pipe whose reader is
 * already gone, then keeps working (an import, a request) while the EPIPE
 * lands, and returns its code.
 */
const binOrder = (size: number, code: number): string =>
  `const { exitAfter } = await import(${JSON.stringify(MODULE)});
   await exitAfter(async () => {
     await new Promise((go) => process.stdin.once('data', go));
     process.stdout.write('x'.repeat(${size}));
     await import('node:path');
     await new Promise((later) => setTimeout(later, 50));
     return ${code};
   });`;

/**
 * The order this replaced: the helper imported only after the command ran,
 * so the EPIPE from a reader already gone landed with no listener.
 */
const importAfterWrite = (size: number, code: number): string =>
  `process.stdin.once('data', async () => {
     process.stdout.write('x'.repeat(${size}));
     await new Promise((later) => setTimeout(later, 50));
     const { flushStdio } = await import(${JSON.stringify(MODULE)});
     await flushStdio();
     process.exit(${code});
   });`;

describe('exitAfter, the bin running a command', () => {
  it('drains a large write to a pipe reader before it exits with the code', async () => {
    const size = 3_000_000;
    const { code, bytes, stderr } = await run(binOrder(size, 3));
    expect(stderr).toBe('');
    expect(code).toBe(3);
    expect(bytes).toBe(size);
  });

  it('exits with its own code when the reader was gone before the command wrote', async () => {
    const { code, stderr } = await run(binOrder(3_000_000, 7), { closeFirst: true });
    expect(stderr).toBe('');
    expect(code).toBe(7);
  });

  // The window the guard closes is real: loaded after the write, the helper
  // is too late, and the EPIPE crashes the process with exit 1.
  it('is needed: a helper loaded after the write cannot keep the code', async () => {
    const { code, stderr } = await run(importAfterWrite(3_000_000, 7), { closeFirst: true });
    expect(code).toBe(1);
    expect(stderr).toContain('EPIPE');
  });
});

describe('flushStdio', () => {
  it('lets a pipe reader take every byte of a large write before the exit', async () => {
    const size = 3_000_000;
    const { code, bytes, stderr } = await run(writeThenExit(size, 0));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(bytes).toBe(size);
  });

  it('exits with its own code, not a crash, when the reader went away (EPIPE)', async () => {
    const { code, stderr } = await run(writeThenExit(3_000_000, 7), { closeFirst: true });
    expect(stderr).toBe('');
    expect(code).toBe(7);
  });
});
