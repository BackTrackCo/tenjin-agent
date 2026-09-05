import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { LoopDb } from '../hooks/store';
import { runRetention } from './retention';
import { health, type PidRecord } from '../hooks/shim';
import {
  LOG_TRUNCATE_BYTES,
  PORT_BASE,
  PORT_SPAN,
  SLEEP_GRACE_MS,
  SLEEP_REARM_MS,
} from '../hooks/constants';
import { daemonLogPath, daemonPidPath } from '../lib/paths';

/**
 * The daemon's lifecycle (02-redesign.md §4, §4a): port, bind, pid file, idle
 * exit, shutdown order, crash handling. Everything here is injectable so
 * `lifecycle.test.ts` runs it with a fake clock and a fake server.
 */

/**
 * `PORT_BASE + sha256(realpath(dataDir))[0..2] % PORT_SPAN`, bound on loopback.
 * The path already contains the home directory, so two users get two ports and
 * a second `TENJIN_DATA_DIR` profile gets its own instead of a silent 401
 * against another profile's daemon. `realpathSync` so a symlinked data dir
 * hashes once.
 */
export function derivePort(dataDir: string): number {
  let path = dataDir;
  try {
    path = realpathSync(dataDir);
  } catch {
    // Not created yet: hash the spelling we were given.
  }
  const h = createHash('sha256').update(path).digest();
  return PORT_BASE + (h.readUInt16BE(0) % PORT_SPAN);
}

/** Truncate an oversized log before appending to it, then append. */
export function openLog(dataDir: string): (line: string) => void {
  const path = daemonLogPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    if (statSync(path).size > LOG_TRUNCATE_BYTES) truncateSync(path, 0);
  } catch {
    // No log yet.
  }
  return (line: string) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Nowhere to say it.
    }
  };
}

export function writePid(dataDir: string, rec: PidRecord): void {
  writeFileSync(daemonPidPath(dataDir), JSON.stringify(rec), { mode: 0o600 });
}

/** Remove the pid file only when it still names THIS process. */
export function removePidIfMine(dataDir: string, pid: number): boolean {
  try {
    const rec = JSON.parse(readFileSync(daemonPidPath(dataDir), 'utf8')) as { pid?: unknown };
    if (rec.pid !== pid) return false;
    rmSync(daemonPidPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

export type BindResult =
  | { kind: 'bound'; port: number }
  | { kind: 'peer'; port: number; version: string }
  | { kind: 'foreign'; port: number; detail: string };

/**
 * Bind on 127.0.0.1. On `EADDRINUSE`, ask the holder: a healthy daemon for the
 * same data dir and version means we lost a benign race and should exit 0;
 * anything else is a foreign listener (log it; doctor will say "set
 * `loop.port`"). The bind is the only mutual exclusion; there is no lock file.
 */
export function bind(
  server: Server,
  port: number,
  dataDir: string,
  version: string,
  probe: typeof health = health,
): Promise<BindResult> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code !== 'EADDRINUSE') {
        resolve({ kind: 'foreign', port, detail: `${err.code ?? err.name}: ${err.message}` });
        return;
      }
      void probe(port).then((h) => {
        if (h !== null && h.data_dir === dataDir) {
          if (h.version === version) resolve({ kind: 'peer', port, version: h.version });
          else
            resolve({
              kind: 'foreign',
              port,
              detail: `daemon ${h.version} (pid ${h.pid}) holds the port`,
            });
        } else {
          resolve({
            kind: 'foreign',
            port,
            detail:
              h === null
                ? 'port held by a foreign listener'
                : `daemon for ${h.data_dir} holds the port`,
          });
        }
      });
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve({
        kind: 'bound',
        port: typeof addr === 'object' && addr !== null ? addr.port : port,
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export interface IdleTimerDeps {
  idleMs: number;
  clock(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onIdle(): void;
  log(line: string): void;
}

/**
 * The idle timer, with the sleep rule: a timer that fires much later than it
 * was armed means the laptop slept, and a session resumed mid-turn must keep
 * its tool fires, so re-arm for {@link SLEEP_REARM_MS} instead of exiting.
 */
export class IdleTimer {
  private handle: unknown = null;
  private lastRequest: number;
  private armedAt: number;
  private armedFor = 0;

  constructor(private readonly deps: IdleTimerDeps) {
    this.lastRequest = deps.clock();
    this.armedAt = this.lastRequest;
    this.arm(deps.idleMs);
  }

  /** Every request resets the clock. */
  touch(): void {
    this.lastRequest = this.deps.clock();
  }

  stop(): void {
    if (this.handle !== null) this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  private arm(ms: number): void {
    this.stop();
    this.armedAt = this.deps.clock();
    this.armedFor = ms;
    this.handle = this.deps.setTimer(() => this.fire(), ms);
  }

  private fire(): void {
    const now = this.deps.clock();
    this.handle = null;
    if (now - this.armedAt > this.armedFor + SLEEP_GRACE_MS) {
      this.deps.log('idle timer late (sleep?); re-arming');
      this.arm(SLEEP_REARM_MS);
      return;
    }
    const idle = now - this.lastRequest;
    if (idle >= this.deps.idleMs) {
      this.deps.onIdle();
      return;
    }
    this.arm(this.deps.idleMs - idle);
  }
}

export interface ShutdownDeps {
  server: Server;
  db: LoopDb;
  dataDir: string;
  pid: number;
  inFlight(): Promise<void>;
  clock(): number;
  log(line: string): void;
  /** Retention runs only on the idle exit, not on a signal or a stop. */
  retention: boolean;
}

/**
 * Listener first, so nothing queues behind synchronous `DatabaseSync` work; a
 * shim arriving mid-exit gets ECONNREFUSED and spawns the successor. Then
 * in-flight fires, retention, checkpoint, close, pid file.
 */
export async function shutdown(d: ShutdownDeps): Promise<void> {
  await new Promise<void>((resolve) => {
    d.server.close(() => resolve());
    d.server.closeIdleConnections();
  });
  await d.inFlight();
  if (d.retention) {
    try {
      const r = runRetention(d.db, d.clock(), d.clock);
      d.log(
        `retention: fires=${r.fires} marks=${r.marks}${r.truncated ? ' (time bound hit)' : ''}`,
      );
    } catch (err) {
      d.log(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    d.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // A CLI reader mid-query; the next open checkpoints.
  }
  try {
    d.db.close();
  } catch {
    // Already closed by a crash path.
  }
  removePidIfMine(d.dataDir, d.pid);
}
