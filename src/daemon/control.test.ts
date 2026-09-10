import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Health, PidRecord } from '../hooks/shim';

/**
 * The daemon a start REPLACES, and the daemon it refuses to build hook entries
 * on top of (tenjin-agent#342).
 *
 * A version match used to be the whole test for "this daemon is current", and
 * it is not one: a build that GAINED a harness carries the same version string
 * as the build before it, so `install` left the old process serving and every
 * `/hook/<new harness>` answered 404 — silently, because a hook failure is a
 * line in daemon.log and nothing else. The route table is the fact, and
 * `/health` now reports it.
 */

const stub = vi.hoisted(() => ({
  pid: null as PidRecord | null,
  health: null as Health | null,
  spawnedHealth: null as Health | null,
  stopped: 0,
  ensured: 0,
}));

vi.mock('../hooks/shim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/shim')>();
  return {
    ...actual,
    readPid: () => stub.pid,
    readToken: () => 'tok',
    health: async () => stub.health,
    ensureDaemon: async () => {
      stub.ensured += 1;
      return { ok: true as const, health: stub.spawnedHealth ?? stub.health!, spawned: true };
    },
  };
});

vi.mock('../../package.json', () => ({ default: { version: '1.0.0' } }));

const { startDaemon } = await import('./control');

let dataDir: string;
let bundleDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-control-data-'));
  bundleDir = await mkdtemp(join(tmpdir(), 'tenjin-control-bundles-'));
  // installDaemonFiles copies these before anything else; their contents are
  // irrelevant here because nothing is spawned.
  for (const name of ['tenjin-daemon.mjs', 'tenjin-shim.mjs', 'tenjin-vitest-reporter.mjs']) {
    await writeFile(join(bundleDir, name), '// stub\n');
  }
  stub.pid = { pid: 7, port: 31000, started_at: 1, data_dir: dataDir };
  stub.health = null;
  stub.spawnedHealth = null;
  stub.stopped = 0;
  stub.ensured = 0;
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(bundleDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A process that is alive until it is signalled. `stopDaemon` only reports a
 * replacement it actually confirmed died, so a start cannot report `replaced`
 * without one.
 */
function fakeProcess(): { kill: (pid: number, signal: NodeJS.Signals | 0) => void } {
  let alive = true;
  return {
    kill: (_pid, signal) => {
      if (signal === 0) {
        if (!alive) throw new Error('ESRCH');
        return;
      }
      alive = false;
    },
  };
}

const noSleep = async (): Promise<void> => undefined;

function running(over: Partial<Health> = {}): Health {
  return {
    version: '1.0.0',
    pid: 7,
    port: 31000,
    uptime_ms: 1,
    idle_ms: 0,
    data_dir: dataDir,
    rss: 1,
    ...over,
  };
}

describe('startDaemon: a route table, not a version string', () => {
  it('keeps a daemon that already serves the harness being wired', async () => {
    stub.health = running({ harnesses: ['claude', 'codex'] });
    const start = await startDaemon(dataDir, { bundleDir, requires: ['codex'] });
    expect(start.replaced).toBeNull();
    expect(start.replacedReason).toBeUndefined();
  });

  /**
   * The exact shape of the bug: same version, same port, healthy, and no
   * `/hook/codex`. Nothing about it looks wrong until a fire returns 404.
   */
  it('replaces a same-version daemon that has no route for it', async () => {
    stub.health = running({ harnesses: ['claude'] });
    stub.spawnedHealth = running({ pid: 9, harnesses: ['claude', 'codex'] });
    const start = await startDaemon(dataDir, {
      bundleDir,
      requires: ['codex'],
      ...fakeProcess(),
      sleep: noSleep,
    });
    expect(start.replacedReason).toBe('missing-routes');
    expect(start.missingRoutes).toEqual(['codex']);
    expect(start.replaced?.pid).toBe(7);
  });

  /**
   * A daemon too old to report `harnesses` at all is treated as serving none of
   * them. That is the safe reading: it may well predate the harness, and the
   * cost of being wrong is one restart that heals itself.
   */
  it('replaces a daemon that does not name its routes', async () => {
    stub.health = running();
    stub.spawnedHealth = running({ pid: 9, harnesses: ['claude', 'codex'] });
    const start = await startDaemon(dataDir, {
      bundleDir,
      requires: ['codex'],
      ...fakeProcess(),
      sleep: noSleep,
    });
    expect(start.replacedReason).toBe('missing-routes');
  });

  it('still replaces an older build, whatever its routes say', async () => {
    stub.health = running({ version: '0.9.0', harnesses: ['claude', 'codex'] });
    stub.spawnedHealth = running({ pid: 9, harnesses: ['claude', 'codex'] });
    const start = await startDaemon(dataDir, {
      bundleDir,
      requires: ['codex'],
      ...fakeProcess(),
      sleep: noSleep,
    });
    expect(start.replacedReason).toBe('older-build');
  });

  /**
   * The check has to be on the daemon that ends up SERVING, not on the one the
   * replace branch looked at: a start that reused a healthy process never goes
   * through that branch at all, and writing hook entries against it would
   * install the 404 rather than fix it.
   */
  it('refuses rather than let hook entries be written against a routeless daemon', async () => {
    stub.health = running({ harnesses: ['claude'] });
    stub.spawnedHealth = running({ harnesses: ['claude'] });
    await expect(startDaemon(dataDir, { bundleDir, requires: ['codex'] })).rejects.toThrow(
      /no route for codex/,
    );
  });

  it('asks for nothing when the caller requires nothing', async () => {
    stub.health = running();
    const start = await startDaemon(dataDir, { bundleDir });
    expect(start.replaced).toBeNull();
  });
});
