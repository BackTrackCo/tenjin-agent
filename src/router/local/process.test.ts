import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('owned subprocess limits with controlled test executables', () => {
  async function fakeNpx(script: string) {
    const dir = await mkdtemp(join(tmpdir(), 'jev-command-test-'));
    directories.push(dir);
    const file = join(dir, 'npx');
    await writeFile(file, script, { mode: 0o700 });
    return { argv: [], outputBytes: 16 * 1024, cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
  }
  it('terminates output-producing children at the bounded output limit', async () => {
    const command = await fakeNpx('#!/bin/sh\nexec /usr/bin/yes output\n');
    const { runBoundedCommand } = await import('./process.js');
    const result = await runBoundedCommand({ ...command, signal: AbortSignal.timeout(2000) });
    expect(result.reason).toBe('output-limit');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024);
  });
  it('cleans up a same-group child after its parent exits before the first scan', async () => {
    const command = await fakeNpx('#!/bin/sh\nexec "$TEST_NODE" "$TEST_SCRIPT"\n');
    const script = join(command.cwd, 'fast-parent.mjs');
    await writeFile(
      script,
      "import { spawn } from 'node:child_process'; const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); child.unref();\n",
    );
    const { runBoundedCommand } = await import('./process.js');
    let pid: number | undefined;
    try {
      const result = await runBoundedCommand({
        ...command,
        env: { ...command.env, TEST_NODE: process.execPath, TEST_SCRIPT: script },
        signal: AbortSignal.timeout(2000),
      });
      pid = Number(result.stdout.trim());
      expect(result.code).toBe(0);
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1500 });
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
  });
  it('cleans up an observed detached descendant on cancellation', async () => {
    const command = await fakeNpx('#!/bin/sh\nexec "$TEST_NODE" "$TEST_SCRIPT"\n');
    const script = join(command.cwd, 'owned-child.mjs');
    await writeFile(
      script,
      "import { spawn } from 'node:child_process'; const c = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' }); process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 10000);\n",
    );
    const { runBoundedCommand } = await import('./process.js');
    let pid: number | undefined;
    try {
      const result = await runBoundedCommand({
        ...command,
        env: { ...command.env, TEST_NODE: process.execPath, TEST_SCRIPT: script },
        signal: AbortSignal.timeout(600),
      });
      pid = Number(result.stdout.trim());
      expect(result.reason).toBe('cancelled');
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1500 });
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
  });
});
