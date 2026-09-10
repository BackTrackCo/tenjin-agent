import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dataDir,
  daemonBundlePath,
  daemonLogPath,
  daemonPidPath,
  daemonSpawnPath,
  daemonTokenPath,
} from '../lib/paths';
import { HARNESS_MS, HEALTH_MS, SLACK_MS, SPAWN_BACKOFF_MS, SPAWN_MS } from './constants';

/**
 * The shim (02-redesign.md §4a): the ensure-running point and the forwarder
 * in one, bundled to `tenjin-shim.mjs` and run by the two `command` hook
 * entries (SessionStart, UserPromptSubmit) and by every other transport's
 * `--ensure`. It imports node builtins only, parses no config and opens no
 * SQLite: its whole job is `GET /health`, maybe one spawn, one POST, exit 0.
 *
 * It never runs an arm, and it never fails the harness: every failure is one
 * `daemon-down` line in `daemon.log`, nothing on stdout, exit 0.
 */

export interface PidRecord {
  pid: number;
  port: number;
  started_at: number;
  data_dir: string;
}

export interface Health {
  version: string;
  pid: number;
  port: number;
  uptime_ms: number;
  idle_ms: number;
  data_dir: string;
  rss: number;
  /**
   * The harnesses the RUNNING process has a route for, sorted. Absent from any
   * older daemon, and that absence is the point: a version string is no proof
   * of a route table, so a build that GAINED a harness looked identical to the
   * one before it and every `/hook/<new harness>` answered 404 until someone
   * restarted by hand (tenjin-agent#342). Absent reads as "serves nothing I
   * can name", never as "serves everything".
   */
  harnesses?: string[];
}

/** The harnesses `h` has no route for, out of the ones a caller needs. */
export function missingRoutes(h: Health, required: readonly string[]): string[] {
  const served = new Set(Array.isArray(h.harnesses) ? h.harnesses : []);
  return required.filter((harness) => !served.has(harness));
}

/** The CLI's `dataDir` under its shim name: one resolution, so the CLI, the shim and the daemon agree on the string. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataDir(env);
}

export function readPid(dataDir: string): PidRecord | null {
  try {
    const raw = JSON.parse(readFileSync(daemonPidPath(dataDir), 'utf8')) as Partial<PidRecord>;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.port === 'number' &&
      typeof raw.started_at === 'number' &&
      typeof raw.data_dir === 'string'
    ) {
      return { pid: raw.pid, port: raw.port, started_at: raw.started_at, data_dir: raw.data_dir };
    }
    return null;
  } catch {
    return null;
  }
}

export function readToken(dataDir: string): string | null {
  try {
    const t = readFileSync(daemonTokenPath(dataDir), 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** One line in `daemon.log`; the only trace a shim leaves when no daemon answers. */
export function logDown(dataDir: string, reason: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    appendFileSync(daemonLogPath(dataDir), `${new Date().toISOString()} daemon-down ${reason}\n`);
  } catch {
    // Nowhere left to say it.
  }
}

/** `GET /health` under `timeoutMs`; null when nothing healthy answers. */
export async function health(port: number, timeoutMs: number = HEALTH_MS): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Health>;
    if (typeof body.pid !== 'number' || typeof body.data_dir !== 'string') return null;
    return body as Health;
  } catch {
    return null;
  }
}

/**
 * The env a daemon starts with. Scrubbed: the spawning hook's env carries
 * `CLAUDE_CODE_SESSION_ID`, which would otherwise stamp every session's rows
 * with the first session's id (`session.ts`). `NODE_OPTIONS` is deliberately
 * NOT kept: a `--require` from one shell would run inside a daemon that serves
 * every session on the machine. `TMP` rides with `TEMP` because `os.tmpdir()`
 * reads both on Windows.
 */
export function daemonEnv(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  out.TENJIN_DATA_DIR = dataDir;
  return out;
}

/** Has a spawn within the backoff window failed to become healthy? */
export function inBackoff(dataDir: string, now: number = Date.now()): boolean {
  try {
    return now - statSync(daemonSpawnPath(dataDir)).mtimeMs < SPAWN_BACKOFF_MS;
  } catch {
    return false;
  }
}

/**
 * Spawn the bundle detached with stdout and stderr on `daemon.log`, and forget
 * it. The backoff file is touched first and removed only by a caller that saw
 * the daemon become healthy.
 */
export function spawnDaemon(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(daemonSpawnPath(dataDir), '');
  const log = openSync(daemonLogPath(dataDir), 'a');
  try {
    const child = spawn(process.execPath, [daemonBundlePath(dataDir)], {
      detached: true,
      stdio: ['ignore', log, log],
      env: daemonEnv(dataDir, env),
      // Never the hook's cwd: a detached daemon would pin a project worktree.
      cwd: dataDir,
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type EnsureResult =
  { ok: true; health: Health; spawned: boolean } | { ok: false; reason: string };

/**
 * Make sure a daemon for `dataDir` is healthy, spawning one if not (unless a
 * recent spawn never became healthy). Port from `daemon.pid`, never derived:
 * the daemon is the only one that knows what it bound.
 */
export async function ensureDaemon(
  dataDir: string,
  opts: { env?: NodeJS.ProcessEnv; spawnMs?: number; now?: () => number } = {},
): Promise<EnsureResult> {
  const now = opts.now ?? (() => Date.now());
  const pid = readPid(dataDir);
  if (pid !== null) {
    const h = await health(pid.port);
    if (h !== null && h.data_dir === dataDir) return { ok: true, health: h, spawned: false };
  }
  if (!existsSync(daemonBundlePath(dataDir)))
    return { ok: false, reason: 'no bundle; run `tenjin daemon start`' };
  if (inBackoff(dataDir, now())) return { ok: false, reason: 'spawn backoff' };
  try {
    spawnDaemon(dataDir, opts.env);
  } catch (err) {
    return {
      ok: false,
      reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const budget = opts.spawnMs ?? SPAWN_MS;
  const until = now() + budget;
  const settled = async (): Promise<Health | null> => {
    const fresh = readPid(dataDir);
    if (fresh === null || (pid !== null && fresh.started_at === pid.started_at)) return null;
    const h = await health(fresh.port);
    return h !== null && h.data_dir === dataDir ? h : null;
  };
  const won = (h: Health): EnsureResult => {
    try {
      unlinkSync(daemonSpawnPath(dataDir));
    } catch {
      // Already gone.
    }
    return { ok: true, health: h, spawned: true };
  };
  while (now() < until) {
    await sleep(20);
    const h = await settled();
    if (h !== null) return won(h);
  }
  // ONE PROBE PAST THE DEADLINE: the loop's last `sleep(20)` can land as the
  // clock passes `until` and skip the probe for a daemon that came up during
  // it. That boundary reported a healthy daemon as "spawned but not healthy
  // within 500 ms" (tenjin-agent#342), a verdict the operator then had to
  // disprove by hand. It costs one probe on a path about to fail anyway.
  const late = await settled();
  if (late !== null) return won(late);
  return { ok: false, reason: `spawned but not healthy within ${budget} ms` };
}

/**
 * `--harness <id>`: ensure, then forward stdin to `/hook/<id>` and write the
 * daemon's body to fd 1 (`writeFileSync`, never `process.stdout.write`: a pipe
 * write is asynchronous and an exit on the next line can truncate it).
 */
export async function forward(
  dataDir: string,
  harness: string,
  stdin: string,
  startedAt: number,
): Promise<void> {
  const token = readToken(dataDir);
  if (token === null) {
    logDown(dataDir, 'no token; run `tenjin daemon start`');
    return;
  }
  const ensured = await ensureDaemon(dataDir);
  if (!ensured.ok) {
    logDown(dataDir, ensured.reason);
    return;
  }
  const remaining = HARNESS_MS - SLACK_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    logDown(dataDir, 'no time left after ensure');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${ensured.health.port}/hook/${harness}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: stdin,
      signal: AbortSignal.timeout(remaining),
    });
    if (res.status === 200) {
      const body = await res.text();
      if (body.length > 0) writeFileSync(1, body);
    } else if (res.status === 404) {
      // The one status with a specific cause and a specific remedy: the daemon
      // answering is from a build with no route for this harness, so every
      // fire is dropped silently until it is replaced (tenjin-agent#342).
      logDown(
        dataDir,
        `hook answered 404: the daemon on 127.0.0.1:${ensured.health.port} (v${ensured.health.version}) has no /hook/${harness} route; run \`tenjin install\` to replace it`,
      );
    } else if (res.status !== 204) {
      logDown(dataDir, `hook answered ${res.status}`);
    }
  } catch (err) {
    logDown(dataDir, `forward failed: ${err instanceof Error ? err.name : String(err)}`);
  }
}
