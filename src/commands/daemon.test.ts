import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json';
import type { CommandContext } from '../context';
import { STOP_GRACE_MS } from '../hooks/constants';
import { ensureDaemon, readPid, readToken, type Health } from '../hooks/shim';
import { CliError } from '../lib/errors';
import { daemonBundlePath, daemonPidPath, daemonTokenPath, shimBundlePath } from '../lib/paths';
import {
  installDaemonFiles,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  stopDaemon,
} from './daemon';

let dataDir: string;
let bundleDir: string;
/** Every pid a test spawned or learned about; SIGKILLed in afterEach regardless of outcome. */
let pids: number[];
let servers: Server[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-b-daemon-'));
  bundleDir = await mkdtemp(join(tmpdir(), 'tenjin-b-bundles-'));
  pids = [];
  servers = [];
});

afterEach(async () => {
  const left = readPid(dataDir);
  if (left !== null) pids.push(left.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(dataDir, { recursive: true, force: true });
  await rm(bundleDir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000 },
    dataDir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/**
 * A daemon stand-in with the surface `commands/daemon.ts` depends on: bind
 * port 0, write `daemon.pid`, answer `/health`, exit cleanly on SIGTERM. The
 * version is baked in because the spawn env is scrubbed to a fixed key list.
 */
function fakeDaemonSource(version: string): string {
  return `
import { createServer } from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dataDir = process.env.TENJIN_DATA_DIR;
const pidPath = join(dataDir, 'daemon.pid');
const started = Date.now();
let port = 0;
const server = createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    version: ${JSON.stringify(version)},
    pid: process.pid,
    port,
    uptime_ms: Date.now() - started,
    idle_ms: 0,
    data_dir: dataDir,
    rss: process.memoryUsage().rss,
  }));
});
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port, started_at: started, data_dir: dataDir }));
});
process.on('SIGTERM', () => {
  server.close();
  try {
    if (JSON.parse(readFileSync(pidPath, 'utf8')).pid === process.pid) rmSync(pidPath, { force: true });
  } catch {}
  process.exit(0);
});
`;
}

async function writeBundles(dir: string, version: string = pkg.version): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tenjin-daemon.mjs'), fakeDaemonSource(version));
  await writeFile(join(dir, 'tenjin-shim.mjs'), '// shim stand-in\n');
}

/** A `/health` stub on port 0 standing in for a live daemon; returns its port. */
async function healthStub(body: Partial<Health>): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

async function writePidFile(pid: number, port: number): Promise<void> {
  await writeFile(
    daemonPidPath(dataDir),
    JSON.stringify({ pid, port, started_at: Date.now(), data_dir: dataDir }),
  );
}

function esrch(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

async function caught<T>(fn: () => Promise<T>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

describe('installDaemonFiles', () => {
  it('copies both bundles into the hooks dir and mints a 0600 token', async () => {
    await writeBundles(bundleDir);
    const { written } = installDaemonFiles(dataDir, bundleDir);
    expect(written).toEqual([
      daemonBundlePath(dataDir),
      shimBundlePath(dataDir),
      daemonTokenPath(dataDir),
    ]);
    expect(await readFile(daemonBundlePath(dataDir), 'utf8')).toBe(fakeDaemonSource(pkg.version));
    expect(await readFile(shimBundlePath(dataDir), 'utf8')).toBe('// shim stand-in\n');
    const token = readToken(dataDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(daemonTokenPath(dataDir))).mode & 0o777).toBe(0o600);
  });

  it('keeps an existing token on a second call', async () => {
    await writeBundles(bundleDir);
    installDaemonFiles(dataDir, bundleDir);
    const token = readToken(dataDir);
    const { written } = installDaemonFiles(dataDir, bundleDir);
    expect(written).toEqual([daemonBundlePath(dataDir), shimBundlePath(dataDir)]);
    expect(readToken(dataDir)).toBe(token);
  });

  it('throws INTERNAL when a bundle is missing', async () => {
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, 'tenjin-daemon.mjs'), '');
    const err = await caught(async () => installDaemonFiles(dataDir, bundleDir));
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toContain('tenjin-shim.mjs');
    expect(readToken(dataDir)).toBeNull();
  });
});

describe('stopDaemon', () => {
  it('reports not-running without a pid file and signals nothing', async () => {
    const calls: unknown[] = [];
    const r = await stopDaemon(dataDir, { kill: (...a) => void calls.push(a) });
    expect(r).toEqual({ state: 'not-running' });
    expect(calls).toEqual([]);
  });

  it('removes a pid file whose process is gone', async () => {
    await writePidFile(424242, 1);
    const r = await stopDaemon(dataDir, {
      kill: () => {
        throw esrch();
      },
    });
    expect(r).toEqual({ state: 'not-running' });
    expect(existsSync(daemonPidPath(dataDir))).toBe(false);
  });

  it('leaves a live pid alone when nothing answers on the recorded port', async () => {
    // A crash-left pid file naming a reused pid: the process is alive but is
    // not our daemon. No signal on hearsay; the file goes, the pid is reported.
    await writePidFile(4242, 1);
    const signals: (NodeJS.Signals | 0)[] = [];
    const r = await stopDaemon(dataDir, { kill: (_pid, sig) => void signals.push(sig) });
    expect(r).toEqual({ state: 'not-running', stalePid: 4242 });
    expect(signals).toEqual([0]);
    expect(existsSync(daemonPidPath(dataDir))).toBe(false);
  });

  it('reports stopped when the process exits after SIGTERM', async () => {
    const port = await healthStub({
      version: pkg.version,
      pid: 4242,
      port: 0,
      uptime_ms: 0,
      idle_ms: 0,
      data_dir: dataDir,
      rss: 0,
    });
    await writePidFile(4242, port);
    const signals: (NodeJS.Signals | 0)[] = [];
    let polls = 0;
    const r = await stopDaemon(dataDir, {
      kill: (pid, sig) => {
        expect(pid).toBe(4242);
        signals.push(sig);
        // Alive on the pre-check, dead on the first poll after SIGTERM.
        if (sig === 0 && signals.filter((s) => s === 0).length > 1) throw esrch();
      },
      sleep: async () => {
        polls++;
      },
    });
    expect(r).toEqual({ state: 'stopped', pid: 4242 });
    expect(signals).toEqual([0, 'SIGTERM', 0]);
    expect(polls).toBe(1);
  });

  it('sends SIGKILL after STOP_GRACE_MS when the process never exits', async () => {
    const port = await healthStub({
      version: pkg.version,
      pid: 4242,
      port: 0,
      uptime_ms: 0,
      idle_ms: 0,
      data_dir: dataDir,
      rss: 0,
    });
    await writePidFile(4242, port);
    const signals: (NodeJS.Signals | 0)[] = [];
    let clock = 1_000_000;
    let killedAt = 0;
    const r = await stopDaemon(dataDir, {
      kill: (_pid, sig) => {
        signals.push(sig);
        if (sig === 'SIGKILL') killedAt = clock;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r).toEqual({ state: 'killed', pid: 4242 });
    expect(signals[1]).toBe('SIGTERM');
    expect(signals.at(-1)).toBe('SIGKILL');
    expect(signals.filter((s) => s === 'SIGKILL')).toHaveLength(1);
    expect(killedAt - 1_000_000).toBeGreaterThanOrEqual(STOP_GRACE_MS);
    expect(existsSync(daemonPidPath(dataDir))).toBe(false);
  });
});

describe('runDaemonStop', () => {
  it('renders each outcome', async () => {
    const ctx = makeCtx();
    expect((await runDaemonStop(ctx)).humanLines).toEqual(['not running']);

    await writePidFile(4242, 1);
    const stale = await runDaemonStop(ctx, { kill: () => {} });
    expect(stale.data).toEqual({ state: 'not-running', stalePid: 4242 });
    expect(stale.humanLines?.[0]).toMatch(/^not running: nothing answered .*pid 4242 left alone/);

    const port = await healthStub({
      version: pkg.version,
      pid: 4242,
      port: 0,
      uptime_ms: 0,
      idle_ms: 0,
      data_dir: dataDir,
      rss: 0,
    });
    await writePidFile(4242, port);
    let clock = 0;
    const killed = await runDaemonStop(ctx, {
      kill: () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(killed.data).toEqual({ state: 'killed', pid: 4242 });
    expect(killed.humanLines).toEqual([
      `killed pid 4242 (did not exit within ${STOP_GRACE_MS} ms)`,
    ]);
  });
});

describe('runDaemonStatus', () => {
  it('reports not-running with the token flag when there is no pid file', async () => {
    const ctx = makeCtx();
    expect((await runDaemonStatus(ctx)).data).toEqual({
      state: 'not-running',
      pidFile: null,
      tokenPresent: false,
    });
    await writeFile(daemonTokenPath(dataDir), 'a'.repeat(64));
    const r = await runDaemonStatus(ctx);
    expect(r.data).toEqual({ state: 'not-running', pidFile: null, tokenPresent: true });
    expect(r.humanLines).toEqual(['not running']);
  });

  it('reports the health fields when /health answers for this data dir', async () => {
    const h: Health = {
      version: pkg.version,
      pid: 777,
      port: 0,
      uptime_ms: 12_000,
      idle_ms: 3_000,
      data_dir: dataDir,
      rss: 40 * 1048576,
    };
    h.port = await healthStub(h);
    await writePidFile(777, h.port);
    const r = await runDaemonStatus(makeCtx());
    expect(r.data).toEqual({ state: 'running', ...h });
    expect(r.humanLines).toEqual([
      `running: pid 777, port ${h.port}, v${pkg.version}`,
      'uptime 12 s, idle 3 s, rss 40 MB',
      `data dir ${dataDir}`,
    ]);
  });

  it('reports not-running when the listener serves another data dir', async () => {
    const port = await healthStub({ pid: 777, data_dir: join(dataDir, 'elsewhere') });
    await writePidFile(777, port);
    const r = await runDaemonStatus(makeCtx());
    expect(r.data).toMatchObject({ state: 'not-running', tokenPresent: false });
    expect((r.data as { pidFile: { pid: number } }).pidFile.pid).toBe(777);
  });
});

describe('runDaemonStart', () => {
  // Real process spawns under a shared laptop: room beyond the 5 s default.
  const SPAWN_CASE_MS = 20_000;
  const deps = () => ({ bundleDir, spawnMs: 5000 });

  it(
    'installs the files, spawns the daemon, then reports it already running',
    async () => {
      await writeBundles(bundleDir);
      const ctx = makeCtx();
      const first = await runDaemonStart(ctx, deps());
      const data = first.data as Record<string, unknown>;
      pids.push(data.pid as number);
      expect(data).toMatchObject({
        state: 'started',
        version: pkg.version,
        dataDir,
        replaced: null,
      });
      expect(data.written).toHaveLength(3);
      expect(readPid(dataDir)).toMatchObject({ pid: data.pid, port: data.port, data_dir: dataDir });
      expect(readToken(dataDir)).toMatch(/^[0-9a-f]{64}$/);
      expect(first.humanLines?.[0]).toBe(
        `started daemon: pid ${data.pid}, port ${data.port}, v${pkg.version}`,
      );

      const second = await runDaemonStart(ctx, deps());
      expect(second.data).toMatchObject({
        state: 'already-running',
        pid: data.pid,
        port: data.port,
        replaced: null,
      });
      expect((second.data as { written: string[] }).written).toHaveLength(2);
      expect(second.humanLines?.[0]).toBe(
        `already running: pid ${data.pid}, port ${data.port}, v${pkg.version}`,
      );
    },
    SPAWN_CASE_MS,
  );

  it(
    'stops and replaces a running daemon from another version',
    async () => {
      const oldDir = join(bundleDir, 'old');
      await writeBundles(oldDir, '0.0.0-older');
      installDaemonFiles(dataDir, oldDir);
      const old = await ensureDaemon(dataDir, { spawnMs: 5000 });
      if (!old.ok) throw new Error(old.reason);
      pids.push(old.health.pid);
      expect(old.health.version).toBe('0.0.0-older');

      await writeBundles(bundleDir);
      const r = await runDaemonStart(makeCtx(), deps());
      const data = r.data as Record<string, unknown>;
      pids.push(data.pid as number);
      expect(data.state).toBe('started');
      expect(data.replaced).toBe(old.health.pid);
      expect(data.pid).not.toBe(old.health.pid);
      expect(data.version).toBe(pkg.version);
      expect(r.humanLines).toContain(`stopped previous daemon pid ${old.health.pid}`);
      expect(() => process.kill(old.health.pid, 0)).toThrow();
      expect(readPid(dataDir)?.pid).toBe(data.pid);
    },
    SPAWN_CASE_MS,
  );

  it('throws INTERNAL when no daemon comes up', async () => {
    await writeBundles(bundleDir);
    await writeFile(join(bundleDir, 'tenjin-daemon.mjs'), 'process.exit(3);\n');
    const err = await caught(() => runDaemonStart(makeCtx(), { bundleDir, spawnMs: 300 }));
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toContain('Daemon did not start');
    expect(err.fix).toContain(join(dataDir, 'daemon.log'));
  });
});
