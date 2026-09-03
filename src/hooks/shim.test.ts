import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonBundlePath,
  daemonLogPath,
  daemonPidPath,
  daemonSpawnPath,
  daemonTokenPath,
  hooksDir,
} from '../lib/paths';
import { SPAWN_BACKOFF_MS } from './constants';
import {
  clearStalePid,
  daemonEnv,
  ensureDaemon,
  forward,
  health,
  inBackoff,
  logDown,
  readPid,
  readToken,
  resolveDataDir,
  type PidRecord,
} from './shim';

/** A pid no OS hands out (above macOS/Linux pid_max, inside int32 for `kill`). */
const DEAD_PID = 2147483000;

let dir: string;
const servers: Server[] = [];
/** Pids of fake daemons this file spawned; SIGKILLed even when a case fails. */
const spawned = new Set<number>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-b-shim-'));
});

afterEach(async () => {
  const pid = readPid(dir);
  if (pid !== null && pid.pid !== process.pid) spawned.add(pid.pid);
  for (const p of spawned) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  spawned.clear();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await rm(dir, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** A port nothing listens on: bind, read, release. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  await new Promise<void>((r) => server.close(() => r()));
  return addr.port;
}

function healthBody(port: number, dataDir: string): string {
  return JSON.stringify({
    version: 't',
    pid: process.pid,
    port,
    uptime_ms: 0,
    idle_ms: 0,
    data_dir: dataDir,
    rss: 0,
  });
}

/** A stub daemon: healthy for `dataDir`, with `onHook` answering `POST /hook/*`. */
async function stubDaemon(dataDir: string, onHook?: Handler): Promise<number> {
  let port = 0;
  port = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(healthBody(port, dataDir));
      return;
    }
    if (onHook !== undefined && req.method === 'POST' && req.url?.startsWith('/hook/')) {
      onHook(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return port;
}

function writePid(dataDir: string, rec: PidRecord): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(daemonPidPath(dataDir), JSON.stringify(rec));
}

function readLog(dataDir: string): string {
  return existsSync(daemonLogPath(dataDir)) ? readFileSync(daemonLogPath(dataDir), 'utf8') : '';
}

/**
 * The smallest thing `spawnDaemon` can start: binds 127.0.0.1:0, writes
 * `daemon.pid` and answers `/health` the way the real bundle does. Exits on its
 * own after 15 s so a failed case can never leave it behind.
 */
const FAKE_BUNDLE = `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dataDir = process.env.TENJIN_DATA_DIR;
let port = 0;
const srv = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      version: 't', pid: process.pid, port, uptime_ms: 0, idle_ms: 0, data_dir: dataDir, rss: 0,
      saw_session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});
srv.listen(0, '127.0.0.1', () => {
  port = srv.address().port;
  writeFileSync(join(dataDir, 'daemon.pid'), JSON.stringify({
    pid: process.pid, port, started_at: Date.now(), data_dir: dataDir,
  }));
});
setTimeout(() => process.exit(0), 15_000);
`;

function writeFakeBundle(dataDir: string): void {
  mkdirSync(hooksDir(dataDir), { recursive: true });
  writeFileSync(daemonBundlePath(dataDir), FAKE_BUNDLE);
}

describe('resolveDataDir', () => {
  it('prefers TENJIN_DATA_DIR and falls back to ~/.tenjin', () => {
    expect(resolveDataDir({ TENJIN_DATA_DIR: '/x/y' })).toBe('/x/y');
    expect(resolveDataDir({})).toBe(join(homedir(), '.tenjin'));
    expect(resolveDataDir({ TENJIN_DATA_DIR: '' })).toBe(join(homedir(), '.tenjin'));
  });
});

describe('readPid', () => {
  it('returns the record when every field is present and typed', () => {
    writePid(dir, { pid: 1, port: 2, started_at: 3, data_dir: dir });
    expect(readPid(dir)).toEqual({ pid: 1, port: 2, started_at: 3, data_dir: dir });
  });

  it('rejects malformed, partial and mistyped files', () => {
    expect(readPid(dir)).toBeNull();
    writeFileSync(daemonPidPath(dir), '{"pid": 1, "port"');
    expect(readPid(dir)).toBeNull();
    writeFileSync(daemonPidPath(dir), '{"pid": 1, "port": 2}');
    expect(readPid(dir)).toBeNull();
    writeFileSync(
      daemonPidPath(dir),
      JSON.stringify({ pid: '1', port: 2, started_at: 3, data_dir: dir }),
    );
    expect(readPid(dir)).toBeNull();
  });
});

describe('readToken', () => {
  it('trims and rejects empty or missing', () => {
    expect(readToken(dir)).toBeNull();
    writeFileSync(daemonTokenPath(dir), '  abc123\n');
    expect(readToken(dir)).toBe('abc123');
    writeFileSync(daemonTokenPath(dir), '\n \n');
    expect(readToken(dir)).toBeNull();
  });
});

describe('logDown', () => {
  it('appends one timestamped daemon-down line per call, creating the dir', () => {
    const nested = join(dir, 'nested');
    logDown(nested, 'no token');
    logDown(nested, 'spawn backoff');
    const lines = readLog(nested).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z daemon-down no token$/);
    expect(lines[1]).toMatch(/ daemon-down spawn backoff$/);
    expect(lines[2]).toBe('');
  });
});

describe('health', () => {
  it('returns the record on 200 JSON with pid and data_dir', async () => {
    const port = await stubDaemon(dir);
    const h = await health(port);
    expect(h).not.toBeNull();
    expect(h?.pid).toBe(process.pid);
    expect(h?.port).toBe(port);
    expect(h?.data_dir).toBe(dir);
  });

  it('is null on a non-200', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(healthBody(0, dir));
    });
    expect(await health(port)).toBeNull();
  });

  it('is null on a 200 whose body is not a health record', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 't', pid: 'x', data_dir: dir }));
    });
    expect(await health(port)).toBeNull();
    const port2 = await listen((_req, res) => {
      res.writeHead(200);
      res.end('not json');
    });
    expect(await health(port2)).toBeNull();
  });

  it('is null when the connection is refused', async () => {
    expect(await health(await freePort())).toBeNull();
  });

  it('is null when nothing answers within timeoutMs', async () => {
    const port = await listen(() => {
      // Never respond: the shim's budget, not the socket, ends this.
    });
    const t0 = Date.now();
    expect(await health(port, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('daemonEnv', () => {
  it('keeps PATH/HOME/proxy vars, drops the session id and strangers, sets the data dir', () => {
    const out = daemonEnv(dir, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://p:1',
      no_proxy: 'localhost',
      NODE_OPTIONS: '--max-old-space-size=64',
      CLAUDE_CODE_SESSION_ID: 'sess-1',
      TENJIN_DATA_DIR: '/somewhere/else',
      AWS_SECRET_ACCESS_KEY: 'nope',
      SHELL: '/bin/zsh',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://p:1',
      no_proxy: 'localhost',
      NODE_OPTIONS: '--max-old-space-size=64',
      TENJIN_DATA_DIR: dir,
    });
  });
});

describe('inBackoff', () => {
  it('is true within SPAWN_BACKOFF_MS of daemon.spawn, false when older or absent', () => {
    expect(inBackoff(dir)).toBe(false);
    writeFileSync(daemonSpawnPath(dir), '');
    expect(inBackoff(dir)).toBe(true);
    expect(inBackoff(dir, Date.now() + SPAWN_BACKOFF_MS - 5000)).toBe(true);
    expect(inBackoff(dir, Date.now() + SPAWN_BACKOFF_MS + 5000)).toBe(false);
  });
});

describe('ensureDaemon', () => {
  it('is ok with spawned:false when daemon.pid points at a healthy daemon for this dir', async () => {
    const port = await stubDaemon(dir);
    writePid(dir, { pid: process.pid, port, started_at: 1, data_dir: dir });
    const r = await ensureDaemon(dir);
    expect(r).toMatchObject({ ok: true, spawned: false });
    if (r.ok) expect(r.health.port).toBe(port);
    expect(existsSync(daemonLogPath(dir))).toBe(false);
    expect(existsSync(daemonSpawnPath(dir))).toBe(false);
  });

  it('does not accept a healthy daemon that serves another data dir', async () => {
    const port = await stubDaemon(join(dir, 'other'));
    writePid(dir, { pid: process.pid, port, started_at: 1, data_dir: dir });
    const r = await ensureDaemon(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no bundle/);
  });

  it('is not ok when there is no bundle to spawn', async () => {
    const r = await ensureDaemon(dir);
    expect(r).toEqual({ ok: false, reason: 'no bundle; run `tenjin daemon start`' });
    expect(existsSync(daemonSpawnPath(dir))).toBe(false);
  });

  it('is not ok and does not spawn while in backoff', async () => {
    writeFakeBundle(dir);
    writeFileSync(daemonSpawnPath(dir), '');
    const r = await ensureDaemon(dir);
    expect(r).toEqual({ ok: false, reason: 'spawn backoff' });
    expect(existsSync(daemonLogPath(dir))).toBe(false);
    expect(readPid(dir)).toBeNull();
  });

  it('spawns the bundle, waits for health, clears the backoff file and scrubs the env', async () => {
    writeFakeBundle(dir);
    const r = await ensureDaemon(dir, {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1' },
      spawnMs: 4000,
    });
    expect(r).toMatchObject({ ok: true, spawned: true });
    if (!r.ok) return;
    spawned.add(r.health.pid);
    expect(r.health.data_dir).toBe(dir);
    expect(r.health.pid).not.toBe(process.pid);
    expect((r.health as unknown as { saw_session: unknown }).saw_session).toBeNull();
    expect(existsSync(daemonSpawnPath(dir))).toBe(false);
    expect(readPid(dir)).toMatchObject({ pid: r.health.pid, port: r.health.port });
  }, 10_000);

  it('supersedes a stale pid file (dead port, old started_at) with the fresh spawn', async () => {
    writeFakeBundle(dir);
    const deadPort = await freePort();
    writePid(dir, { pid: DEAD_PID, port: deadPort, started_at: 1, data_dir: dir });
    const r = await ensureDaemon(dir, { spawnMs: 4000 });
    expect(r).toMatchObject({ ok: true, spawned: true });
    if (!r.ok) return;
    spawned.add(r.health.pid);
    expect(r.health.port).not.toBe(deadPort);
    const fresh = readPid(dir);
    expect(fresh?.pid).toBe(r.health.pid);
    expect(fresh?.started_at).not.toBe(1);
    expect(existsSync(daemonSpawnPath(dir))).toBe(false);
  }, 10_000);

  it('is not ok, leaving the backoff file, when the spawn never becomes healthy', async () => {
    mkdirSync(hooksDir(dir), { recursive: true });
    writeFileSync(daemonBundlePath(dir), 'process.exit(0);\n');
    const r = await ensureDaemon(dir, { spawnMs: 200 });
    expect(r).toEqual({ ok: false, reason: 'spawned but not healthy within 200 ms' });
    expect(existsSync(daemonSpawnPath(dir))).toBe(true);
    expect(inBackoff(dir)).toBe(true);
  }, 10_000);
});

describe('forward', () => {
  it('logs daemon-down and sends nothing when there is no token', async () => {
    const port = await stubDaemon(dir, (_req, res) => {
      res.writeHead(500);
      res.end();
    });
    writePid(dir, { pid: process.pid, port, started_at: 1, data_dir: dir });
    await forward(dir, 'claude', '{}', Date.now());
    expect(readLog(dir)).toMatch(/ daemon-down no token; run `tenjin daemon start`\n$/);
  });

  it('POSTs stdin verbatim to /hook/<harness> with the bearer token; 204 leaves no log', async () => {
    let seen: { url?: string; auth?: string; type?: string; body: string } | null = null;
    const port = await stubDaemon(dir, (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        seen = {
          url: req.url,
          auth: req.headers.authorization,
          type: req.headers['content-type'],
          body,
        };
        res.writeHead(204);
        res.end();
      });
    });
    writePid(dir, { pid: process.pid, port, started_at: 1, data_dir: dir });
    writeFileSync(daemonTokenPath(dir), 'tok-abc\n');
    const stdin = '{"hook_event_name":"UserPromptSubmit","prompt":"hi \\u00e9"}\n';
    await forward(dir, 'claude', stdin, Date.now());
    expect(seen).toEqual({
      url: '/hook/claude',
      auth: 'Bearer tok-abc',
      type: 'application/json',
      body: stdin,
    });
    expect(readLog(dir)).toBe('');
  });

  it('logs "hook answered 500" on a 500', async () => {
    const port = await stubDaemon(dir, (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    writePid(dir, { pid: process.pid, port, started_at: 1, data_dir: dir });
    writeFileSync(daemonTokenPath(dir), 'tok-abc');
    await forward(dir, 'claude', '{}', Date.now());
    expect(readLog(dir)).toMatch(/ daemon-down hook answered 500\n$/);
  });

  it('logs the ensure reason when no daemon can be reached', async () => {
    writeFileSync(daemonTokenPath(dir), 'tok-abc');
    await forward(dir, 'claude', '{}', Date.now());
    expect(readLog(dir)).toMatch(/ daemon-down no bundle; run `tenjin daemon start`\n$/);
  });
});

describe('clearStalePid', () => {
  it('removes the pid file when the recorded pid is dead', () => {
    writePid(dir, { pid: DEAD_PID, port: 1, started_at: 1, data_dir: dir });
    clearStalePid(dir);
    expect(existsSync(daemonPidPath(dir))).toBe(false);
  });

  it('keeps the pid file when the recorded pid is alive', () => {
    writePid(dir, { pid: process.pid, port: 1, started_at: 1, data_dir: dir });
    clearStalePid(dir);
    expect(existsSync(daemonPidPath(dir))).toBe(true);
  });

  it('is a no-op without a readable pid file', () => {
    writeFileSync(daemonPidPath(dir), '{');
    clearStalePid(dir);
    expect(existsSync(daemonPidPath(dir))).toBe(true);
  });
});
