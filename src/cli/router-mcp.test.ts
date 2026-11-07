import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli';
import { captureIo } from '../context-test-utils';
import { collect } from '../lib/runtime-activate';
import { runtimeStatePath, versionDir } from '../lib/runtime-layout';

/**
 * `tenjin mcp` marks the runtime version it runs from as live for as long as
 * it serves, so an update's `collect` never removes a build an open session
 * still runs. This file runs the CLI from source, not from a runtime, so the
 * mark the server asks for in its own folder lands in a runtime version's
 * `dist` in a sandbox instead.
 */
const seams = vi.hoisted(() => ({
  marked: [] as string[],
  dist: '',
  serving: async (): Promise<void> => undefined,
}));
vi.mock('../lib/runtime-layout', async (original) => {
  const actual = await original<typeof import('../lib/runtime-layout')>();
  return {
    ...actual,
    markLive: (moduleDir: string, pid?: number) => {
      seams.marked.push(moduleDir);
      return actual.markLive(seams.dist, pid);
    },
  };
});
vi.mock('../router/mcp', () => ({ runRouterMcpServer: () => seams.serving() }));

let sandbox: string;
const prevEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenjin-mcp-live-'));
  for (const key of ['CI', 'HOME', 'TENJIN_DATA_DIR']) prevEnv[key] = process.env[key];
  process.env.CI = '1';
  process.env.HOME = join(sandbox, 'home');
  process.env.TENJIN_DATA_DIR = join(sandbox, 'home', '.tenjin');
});
afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

it('marks the version it runs from while it serves, so collect spares it', async () => {
  // Two updates since this session's server started: its version is now
  // neither current nor previous, which is what collect removes.
  const root = join(sandbox, 'runtime');
  const running = versionDir(root, '1.0.0');
  seams.dist = join(running, 'dist');
  mkdirSync(seams.dist, { recursive: true });
  writeFileSync(join(seams.dist, 'index.js'), '');
  writeFileSync(
    runtimeStatePath(root),
    JSON.stringify({
      schemaVersion: 1,
      current: { cli: '1.2.0', node: '24.0.0' },
      previous: { cli: '1.1.0', node: '24.0.0' },
      pending: null,
    }),
  );
  let kept: { path: string; reason: string }[] = [];
  seams.serving = async () => {
    kept = (await collect(root)).kept;
  };

  expect(await main(['mcp'], captureIo().io)).toBe(0);

  // The server's own folder, which in the runtime is `versions/<cli>/dist`.
  expect(seams.marked).toEqual([dirname(fileURLToPath(import.meta.url))]);
  expect(kept).toContainEqual({ path: running, reason: 'a running tenjin mcp uses it' });
  expect(existsSync(running)).toBe(true);
  // The mark goes when the server stops.
  expect(existsSync(join(running, '.live', String(process.pid)))).toBe(false);
});
