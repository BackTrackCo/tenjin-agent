import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { configPath, defaultDataDir, runtimeDir } from './paths';
import { nodeBinPath, readRuntimeState, versionEntry } from './runtime-layout';

/**
 * BACKGROUND AUTO-UPDATE, the way Claude Code's native installer does it:
 * downloaded in the background, used from the next session. At most once a
 * day, at the start of a Claude Code session or the end of a Codex one, this
 * starts `tenjin update --background` DETACHED on the runtime's own Node and
 * current entry, and returns: the caller adds no latency and never waits.
 * The child is `tenjin update`'s runtime branch (the release's build
 * provenance is checked before it is downloaded and the build before the
 * switch, the previous version stays, an older one is never switched to, the
 * runtime lock is held), except that it takes only a release published at
 * least a day ago (`BACKGROUND_COOLDOWN_MS` in commands/update). So npm and PATH
 * are never involved, and a running Claude Code session keeps its version
 * until the next one.
 * Codex's hooks run the launcher, which the switch rewrites, so Codex starts
 * the update as its session ends and the next session starts on the new one.
 *
 * `node:*`, the paths and the runtime layout only: the `alive` leg and
 * `tenjin mcp` load this, and neither may pay for zod, the config schema or
 * the runtime's writer. The config is read raw for the same reason.
 *
 *   <root>/auto-update.json  when the last run started, and how it ended
 *   <root>/auto-update.log   the last run's output, overwritten each run
 */

export const AUTO_UPDATE_FILE = 'auto-update.json';
export const AUTO_UPDATE_LOG = 'auto-update.log';

const DAY_MS = 86_400_000;

export interface AutoUpdateRecord {
  /** When the last background run was started (ISO). */
  startedAt?: string;
  /** When it finished (ISO); absent while it runs, or if it died. */
  finishedAt?: string;
  outcome?: 'updated' | 'current' | 'failed' | 'skipped';
  from?: string;
  to?: string;
  reason?: string;
}

type Spawn = typeof spawn;

/**
 * Start the background update if one is due. Synchronous and never throws:
 * every gate that does not hold returns without spawning, and so does any
 * error, since the session it rides on must start regardless.
 */
export function maybeAutoUpdate(o: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  spawnImpl?: Spawn;
}): void {
  try {
    const { env } = o;
    // The same two doors the update nudge has (lib/update-check).
    if (env.CI !== undefined && env.CI.length > 0) return;
    if (env.TENJIN_NO_UPDATE_CHECK === '1') return;
    const home = o.home ?? homedir();
    if (resolve(o.dataDir) !== resolve(defaultDataDir(home))) return;
    if (!autoMode(o.dataDir)) return;

    const root = runtimeDir(o.dataDir);
    const state = readRuntimeState(root);
    if (state === null) return;
    const node = nodeBinPath(root, state.current.node);
    const entry = versionEntry(root, state.current.cli);
    if (!existsSync(node) || !existsSync(entry)) return;

    const nowMs = (o.now ?? Date.now)();
    const previous = readAutoUpdate(root);
    const started = Date.parse(previous?.startedAt ?? '');
    // A start in the future (a clock set back) counts as due, not as a day away.
    if (!Number.isNaN(started) && nowMs - started >= 0 && nowMs - started < DAY_MS) return;

    // Stamped BEFORE the spawn, so a second session starting in the same
    // second finds it and stays put. The last result is kept for doctor.
    writeRecord(root, { ...previous, startedAt: new Date(nowMs).toISOString() });
    const fd = openSync(join(root, AUTO_UPDATE_LOG), 'w', 0o600);
    try {
      const child = (o.spawnImpl ?? spawn)(node, [entry, 'update', '--background'], {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: home,
        windowsHide: true,
        // The child's own nudge would ask npm again for what it just learned.
        env: { ...env, TENJIN_NO_UPDATE_CHECK: '1' },
      });
      child.on('error', () => undefined);
      child.unref();
    } finally {
      closeSync(fd);
    }
  } catch {
    // Never the session's business.
  }
}

/**
 * `update.mode` as stored, read without the config schema: absent (the
 * default) or `auto` runs; `nudge` and `off` were typed by the person, and an
 * unparsable file is not read as consent. A missing file is the default.
 */
function autoMode(dataDir: string): boolean {
  let text: string;
  try {
    text = readFileSync(configPath(dataDir), 'utf8');
  } catch {
    return true;
  }
  const raw = JSON.parse(text) as { update?: { mode?: unknown } } | null;
  const mode = raw?.update?.mode;
  return mode === undefined || mode === 'auto';
}

/** The last run's record, or null when there is none or it is unreadable. */
export function readAutoUpdate(root: string): AutoUpdateRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, AUTO_UPDATE_FILE), 'utf8')) as unknown;
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as AutoUpdateRecord)
      : null;
  } catch {
    return null;
  }
}

/**
 * Replace the record with how a run ended, keeping when it started, so no
 * field of an earlier run survives into this one. Throws; the caller decides.
 */
export function recordAutoUpdate(root: string, result: Omit<AutoUpdateRecord, 'startedAt'>): void {
  const startedAt = readAutoUpdate(root)?.startedAt;
  writeRecord(root, { ...(startedAt !== undefined ? { startedAt } : {}), ...result });
}

function writeRecord(root: string, record: AutoUpdateRecord): void {
  const path = join(root, AUTO_UPDATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Doctor's one line about the last finished run, or null when there is none. */
export function autoUpdateLine(root: string): string | null {
  const r = readAutoUpdate(root);
  if (r === null || r.finishedAt === undefined) return null;
  const when = r.finishedAt.slice(0, 10);
  if (r.outcome === 'updated') return `Auto-update: ${when} updated ${r.from} -> ${r.to}`;
  if (r.outcome === 'current') return `Auto-update: ${when} up to date (${r.to ?? r.from})`;
  if (r.outcome === 'failed') return `Auto-update: ${when} failed: ${r.reason ?? 'unknown'}`;
  // A run that chose to wait (a release under a day old, TLS checks turned
  // off) says why, so the person sees what holds the update back.
  if (r.outcome === 'skipped' && r.reason !== undefined) {
    return `Auto-update: ${when} skipped: ${r.reason}`;
  }
  return null;
}
