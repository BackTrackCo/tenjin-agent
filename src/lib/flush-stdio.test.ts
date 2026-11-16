import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE BIN'S LAST STEP, run for real: `exitAfter`, the bin's only entry into
 * this module, in a child process whose stdout is a pipe, as an agent's shell
 * reads it, or a file. `tenjin pay` printed a 557 KB body into a pipe and
 * exited before the pipe drained, so the reader got the first 64 KB; a file
 * at its size limit took nothing and the bin still exited 0.
 */

const MODULE = pathToFileURL(fileURLToPath(new URL('./flush-stdio.ts', import.meta.url))).href;
/** Node strips types by default from 22.18 and 23.6; older builds need the flag. */
const STRIP = (process.features as { typescript?: unknown }).typescript
  ? []
  : ['--experimental-strip-types'];
/** The module's own imports are extensionless, as the bundler takes them: a
 *  resolve hook in the child finds the `.ts` file behind each. */
const RESOLVE_TS = `export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\//.test(specifier)) return next(specifier + '.ts', context);
    throw err;
  }
}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flush-stdio-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Runs `script` with stdout piped here. With `closeFirst`, this side closes
 * its end of the pipe, then tells the child to go on stdin: every write the
 * child makes after that fails with EPIPE. With `closeMidway`, it closes once
 * the first bytes arrive, while the child's exit waits for the rest to drain.
 * With `full`, stdout is instead appended to that file, under a file size
 * limit the file is already past: every write fails with EFBIG.
 */
function run(
  script: string,
  opts: { closeFirst?: boolean; closeMidway?: boolean; full?: string } = {},
): Promise<{ code: number | null; bytes: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const node = [process.execPath, ...STRIP, '--no-warnings', '--input-type=module', '-e', script];
    const child =
      opts.full === undefined
        ? spawn(node[0]!, node.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-c', 'ulimit -f 1 && exec "$@" >>"$OUT"', 'sh', ...node], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, OUT: opts.full },
          });
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (opts.closeMidway === true) child.stdout.destroy();
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

/**
 * The bin's order (src/index.ts): the helper is loaded and its guard is on
 * before the command runs. The command writes, then keeps working (an
 * import, a request) and returns its code. With `closed`, the reader is
 * already gone, and the command works on until the EPIPE has landed and
 * closed stdout: an event, never a timer. With `paid`, it has sent a payment
 * first, as `runPay` does.
 */
const binOrder = (
  size: number,
  code: number,
  opts: { closed?: boolean; paid?: boolean } = {},
): string =>
  `import { register } from 'node:module';
   register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(RESOLVE_TS)}));
   const { exitAfter, notePaymentSent } = await import(${JSON.stringify(MODULE)});
   await exitAfter(async () => {
     await new Promise((go) => process.stdin.once('data', go));
     ${opts.paid === true ? 'notePaymentSent();' : ''}
     process.stdout.write('x'.repeat(${size}));
     await import('node:path');
     ${opts.closed === true ? "if (!process.stdout.closed) await new Promise((closed) => process.stdout.once('close', closed));" : ''}
     return ${code};
   });`;

/** A file already past a one-block size limit. */
async function fullFile(): Promise<string> {
  const path = join(dir, 'out.txt');
  await writeFile(path, 'x'.repeat(64 * 1024));
  return path;
}

describe('exitAfter, the bin running a command', () => {
  it('drains a large write to a pipe reader before it exits with the code', async () => {
    const size = 3_000_000;
    const { code, bytes, stderr } = await run(binOrder(size, 3));
    expect(stderr).toBe('');
    expect(code).toBe(3);
    expect(bytes).toBe(size);
  });

  it('exits with its own code when the reader was gone before the command wrote', async () => {
    const { code, stderr } = await run(binOrder(3_000_000, 7, { closed: true }), {
      closeFirst: true,
    });
    expect(stderr).toBe('');
    expect(code).toBe(7);
  });

  it('exits with its own code when the reader leaves while the output drains', async () => {
    const { code, bytes, stderr } = await run(binOrder(3_000_000, 7), { closeMidway: true });
    expect(stderr).toBe('');
    expect(code).toBe(7);
    expect(bytes).toBeLessThan(3_000_000);
  });

  // Only a closed pipe is benign. Output that could not be written (a full
  // disk, a file at its limit) was lost, and the exit said success.
  describe.skipIf(process.platform === 'win32')('stdout that cannot be written', () => {
    it('says so on stderr and exits 1', async () => {
      const { code, stderr } = await run(binOrder(1_000, 0), { full: await fullFile() });
      expect(code).toBe(1);
      expect(stderr).toMatch(/^tenjin: the output could not be written \(EFBIG/);
      expect(stderr).not.toContain('tenjin payments');
    });

    it('says a payment was made and where it is recorded, and exits 4', async () => {
      const { code, stderr } = await run(binOrder(1_000, 0, { paid: true }), {
        full: await fullFile(),
      });
      expect(code).toBe(4);
      expect(stderr).toContain('after a payment was made');
      expect(stderr).toContain('`tenjin payments`');
    });

    it("keeps a failing command's own code", async () => {
      const { code, stderr } = await run(binOrder(1_000, 3), { full: await fullFile() });
      expect(code).toBe(3);
      expect(stderr).toContain('the output could not be written');
    });
  });
});
