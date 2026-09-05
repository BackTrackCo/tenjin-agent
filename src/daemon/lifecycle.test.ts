import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bind,
  derivePort,
  IdleTimer,
  openLog,
  removePidIfMine,
  shutdown,
  writePid,
  type IdleTimerDeps,
} from './lifecycle';
import {
  LOG_TRUNCATE_BYTES,
  PORT_BASE,
  PORT_SPAN,
  RETENTION_DAYS,
  SLEEP_GRACE_MS,
  SLEEP_REARM_MS,
} from '../hooks/constants';
import type { Health } from '../hooks/shim';
import { openLoopDb } from '../hooks/store';
import { daemonLogPath, daemonPidPath } from '../lib/paths';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'tenjin-b-lifecycle-'));
  dirs.push(d);
  return d;
}

const servers: Server[] = [];
function trackedServer(): Server {
  const s = createServer((_req, res) => res.end('ok'));
  servers.push(s);
  return s;
}
async function listening(s: Server): Promise<number> {
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const addr = s.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return addr.port;
}

/** A connect attempt's outcome: the error code, or 'connected'. */
function tryConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    sock.once('connect', () => {
      sock.destroy();
      resolve('connected');
    });
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('derivePort', () => {
  it('is stable and inside [PORT_BASE, PORT_BASE + PORT_SPAN)', async () => {
    const dir = await tempDir();
    const port = derivePort(dir);
    expect(derivePort(dir)).toBe(port);
    expect(port).toBeGreaterThanOrEqual(PORT_BASE);
    expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
    expect(PORT_BASE + PORT_SPAN).toBe(32_000);
  });

  it('hashes a symlink to the data dir the same as the dir', async () => {
    const dir = await tempDir();
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    expect(derivePort(link)).toBe(derivePort(real));
  });

  it('does not throw for a dir that does not exist yet', async () => {
    const dir = await tempDir();
    const missing = join(dir, 'not-created');
    const port = derivePort(missing);
    expect(port).toBeGreaterThanOrEqual(PORT_BASE);
    expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
    expect(derivePort(missing)).toBe(port);
  });
});

describe('openLog', () => {
  const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (.*)$/;

  it('creates the dir and appends ISO-stamped lines', async () => {
    const dir = join(await tempDir(), 'nested');
    const log = openLog(dir);
    log('first');
    log('second');
    const lines = readFileSync(daemonLogPath(dir), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines[0]?.match(ISO_LINE)?.[1]).toBe('first');
    expect(lines[1]?.match(ISO_LINE)?.[1]).toBe('second');
  });

  it('keeps a log at the threshold and appends to it', async () => {
    const dir = await tempDir();
    const path = daemonLogPath(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, LOG_TRUNCATE_BYTES);
    openLog(dir)('kept');
    expect(statSync(path).size).toBeGreaterThan(LOG_TRUNCATE_BYTES);
  });

  it('truncates a log over LOG_TRUNCATE_BYTES before appending', async () => {
    const dir = await tempDir();
    const path = daemonLogPath(dir);
    // A sparse file: the size is what the check reads, not the bytes.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, LOG_TRUNCATE_BYTES + 1);
    openLog(dir)('fresh');
    const body = readFileSync(path, 'utf8');
    expect(body.length).toBeLessThan(200);
    expect(body.split('\n')[0]?.match(ISO_LINE)?.[1]).toBe('fresh');
  });
});

describe('writePid / removePidIfMine', () => {
  const rec = (pid: number, dataDir: string) => ({
    pid,
    port: 30_123,
    started_at: 1_700_000_000_000,
    data_dir: dataDir,
  });

  it('removes only when the recorded pid matches', async () => {
    const dir = await tempDir();
    writePid(dir, rec(4242, dir));
    expect(JSON.parse(readFileSync(daemonPidPath(dir), 'utf8'))).toEqual(rec(4242, dir));
    if (process.platform !== 'win32') {
      expect(statSync(daemonPidPath(dir)).mode & 0o777).toBe(0o600);
    }

    expect(removePidIfMine(dir, 4243)).toBe(false);
    expect(existsSync(daemonPidPath(dir))).toBe(true);

    expect(removePidIfMine(dir, 4242)).toBe(true);
    expect(existsSync(daemonPidPath(dir))).toBe(false);
  });

  it('returns false when the pid file is absent or unreadable', async () => {
    const dir = await tempDir();
    expect(removePidIfMine(dir, 4242)).toBe(false);
    expect(removePidIfMine(join(dir, 'never-made'), 4242)).toBe(false);
  });
});

describe('bind', () => {
  const VERSION = '0.1.0-test';
  const healthOf = (over: Partial<Health>): Health => ({
    version: VERSION,
    pid: 999,
    port: 0,
    uptime_ms: 1,
    idle_ms: 0,
    data_dir: '/nowhere',
    rss: 1,
    ...over,
  });

  it('binds a real server on port 0 and reports the port it got', async () => {
    const dir = await tempDir();
    const server = trackedServer();
    const probe = vi.fn(async () => null);
    const r = await bind(server, 0, dir, VERSION, probe);
    expect(r.kind).toBe('bound');
    expect(r.port).toBeGreaterThan(0);
    const addr = server.address();
    expect(typeof addr === 'object' && addr !== null ? addr.port : -1).toBe(r.port);
    expect(probe).not.toHaveBeenCalled();
    expect(await tryConnect(r.port)).toBe('connected');
  });

  it('reports a peer when the holder serves the same data dir and version', async () => {
    const dir = await tempDir();
    const port = await listening(trackedServer());
    const probe = vi.fn(async () => healthOf({ data_dir: dir, port }));
    const r = await bind(trackedServer(), port, dir, VERSION, probe);
    expect(r).toEqual({ kind: 'peer', port, version: VERSION });
    expect(probe).toHaveBeenCalledWith(port);
  });

  it('reports foreign when the holder is a different version', async () => {
    const dir = await tempDir();
    const port = await listening(trackedServer());
    const probe = async () => healthOf({ data_dir: dir, version: '9.9.9', pid: 777 });
    const r = await bind(trackedServer(), port, dir, VERSION, probe);
    expect(r).toEqual({ kind: 'foreign', port, detail: 'daemon 9.9.9 (pid 777) holds the port' });
  });

  it('reports foreign when the holder serves another data dir', async () => {
    const dir = await tempDir();
    const port = await listening(trackedServer());
    const probe = async () => healthOf({ data_dir: '/some/other/profile' });
    const r = await bind(trackedServer(), port, dir, VERSION, probe);
    expect(r).toEqual({
      kind: 'foreign',
      port,
      detail: 'daemon for /some/other/profile holds the port',
    });
  });

  it('reports foreign with detail when the probe returns null', async () => {
    const dir = await tempDir();
    const port = await listening(trackedServer());
    const r = await bind(trackedServer(), port, dir, VERSION, async () => null);
    expect(r).toEqual({ kind: 'foreign', port, detail: 'port held by a foreign listener' });
  });

  it('reports foreign on a non-EADDRINUSE error without probing', async () => {
    const dir = await tempDir();
    // A listener that fails the way a privileged port does; node's own
    // `EACCES` is not reproducible on a mac (ports under 1024 are open).
    class Refusing extends EventEmitter {
      listen(): this {
        queueMicrotask(() =>
          this.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' })),
        );
        return this;
      }
      address(): null {
        return null;
      }
    }
    const probe = vi.fn(async () => null);
    const r = await bind(new Refusing() as unknown as Server, 30_500, dir, VERSION, probe);
    expect(r).toEqual({ kind: 'foreign', port: 30_500, detail: 'EACCES: permission denied' });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('IdleTimer', () => {
  const IDLE_MS = 1000;

  function harness() {
    let now = 0;
    const armed: Array<{ fn: () => void; ms: number; handle: number }> = [];
    const cleared: unknown[] = [];
    const onIdle = vi.fn();
    const log = vi.fn();
    const deps: IdleTimerDeps = {
      idleMs: IDLE_MS,
      clock: () => now,
      setTimer(fn, ms) {
        const handle = armed.length + 1;
        armed.push({ fn, ms, handle });
        return handle;
      },
      clearTimer(handle) {
        cleared.push(handle);
      },
      onIdle,
      log,
    };
    const last = () => {
      const t = armed[armed.length - 1];
      if (t === undefined) throw new Error('nothing armed');
      return t;
    };
    /** Fire the latest timer as if the clock had reached `at`. */
    const fireAt = (at: number) => {
      now = at;
      last().fn();
    };
    return { deps, armed, cleared, onIdle, log, last, fireAt, setNow: (t: number) => (now = t) };
  }

  it('arms for idleMs and calls onIdle when the timer fires idle', () => {
    const h = harness();
    new IdleTimer(h.deps);
    expect(h.armed).toHaveLength(1);
    expect(h.last().ms).toBe(IDLE_MS);
    h.fireAt(IDLE_MS);
    expect(h.onIdle).toHaveBeenCalledTimes(1);
    expect(h.armed).toHaveLength(1);
    expect(h.log).not.toHaveBeenCalled();
  });

  it('a touch() before the fire re-arms for the remainder instead of exiting', () => {
    const h = harness();
    const t = new IdleTimer(h.deps);
    h.setNow(600);
    t.touch();
    h.fireAt(IDLE_MS);
    expect(h.onIdle).not.toHaveBeenCalled();
    expect(h.armed).toHaveLength(2);
    expect(h.last().ms).toBe(IDLE_MS - 400);
    // The re-arm covers the remainder from the touch, so the real fire time
    // is lastRequest (600) + idleMs (1000), not the original arm time + idleMs.
    h.fireAt(600 + IDLE_MS);
    expect(h.onIdle).toHaveBeenCalledTimes(1);
  });

  it('a fire more than SLEEP_GRACE_MS late logs and re-arms for SLEEP_REARM_MS', () => {
    const h = harness();
    new IdleTimer(h.deps);
    const woke = IDLE_MS + SLEEP_GRACE_MS + 1;
    h.fireAt(woke);
    expect(h.onIdle).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('idle timer late (sleep?); re-arming');
    expect(h.armed).toHaveLength(2);
    expect(h.last().ms).toBe(SLEEP_REARM_MS);
    // Still nobody: the re-armed timer exits on time.
    h.fireAt(woke + SLEEP_REARM_MS);
    expect(h.onIdle).toHaveBeenCalledTimes(1);
  });

  it('a fire exactly SLEEP_GRACE_MS late is on time', () => {
    const h = harness();
    new IdleTimer(h.deps);
    h.fireAt(IDLE_MS + SLEEP_GRACE_MS);
    expect(h.onIdle).toHaveBeenCalledTimes(1);
    expect(h.log).not.toHaveBeenCalled();
  });

  it('stop() clears the armed timer once', () => {
    const h = harness();
    const t = new IdleTimer(h.deps);
    expect(h.cleared).toEqual([]);
    t.stop();
    expect(h.cleared).toEqual([h.last().handle]);
    t.stop();
    expect(h.cleared).toHaveLength(1);
  });
});

describe('shutdown', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  async function setUp(retention: boolean, pid: number) {
    const dir = await tempDir();
    const server = trackedServer();
    const port = await listening(server);
    const db = openLoopDb(dir);
    writePid(dir, { pid, port, started_at: Date.now(), data_dir: dir });
    const lines: string[] = [];
    const gate = deferred();
    const inFlight = vi.fn(() => gate.promise);
    const done = shutdown({
      server,
      db,
      dataDir: dir,
      pid: process.pid,
      inFlight,
      clock: () => Date.now(),
      log: (l) => lines.push(l),
      retention,
    });
    return { dir, server, port, db, lines, gate, inFlight, done };
  }

  it('closes the listener before in-flight fires resolve, then retention, db, pid', async () => {
    const dir = await tempDir();
    const server = trackedServer();
    const port = await listening(server);
    const db = openLoopDb(dir);
    const old = Date.now() - (RETENTION_DAYS + 1) * DAY_MS;
    db.prepare(
      `INSERT INTO fires (id, at, session, arm, harness, event, wait, deadline_ms, elapsed_ms, reason)
       VALUES ('f-old', ?, 's', 'prompt', 'claude', 'UserPromptSubmit', 'human', 2500, 1, 'ok')`,
    ).run(old);
    db.prepare(`INSERT INTO marks (session, key, value, at) VALUES ('s', 'k', 'v', ?)`).run(old);
    writePid(dir, { pid: process.pid, port, started_at: Date.now(), data_dir: dir });
    const lines: string[] = [];
    const gate = deferred();
    const inFlight = vi.fn(() => gate.promise);

    const closed = once(server, 'close');
    const done = shutdown({
      server,
      db,
      dataDir: dir,
      pid: process.pid,
      inFlight,
      clock: () => Date.now(),
      log: (l) => lines.push(l),
      retention: true,
    });
    await closed;

    // Listener gone while the fires are still in flight: a shim arriving now
    // is refused and spawns the successor instead of queueing behind us.
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
    expect(inFlight).toHaveBeenCalledTimes(1);
    expect(db.isOpen).toBe(true);
    expect(existsSync(daemonPidPath(dir))).toBe(true);
    expect(lines).toEqual([]);

    gate.resolve();
    await done;
    expect(lines).toEqual(['retention: fires=1 marks=1']);
    expect(db.isOpen).toBe(false);
    expect(existsSync(daemonPidPath(dir))).toBe(false);
  });

  it('skips retention when retention is false', async () => {
    const s = await setUp(false, process.pid);
    s.gate.resolve();
    await s.done;
    expect(s.lines).toEqual([]);
    expect(s.db.isOpen).toBe(false);
    expect(existsSync(daemonPidPath(s.dir))).toBe(false);
  });

  it('leaves a pid file that names another process', async () => {
    const s = await setUp(false, process.pid + 1);
    s.gate.resolve();
    await s.done;
    expect(s.db.isOpen).toBe(false);
    expect(existsSync(daemonPidPath(s.dir))).toBe(true);
  });
});
