import { readFile, readdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../lib/atomic-json';
import { hasCode } from '../lib/errno';
import type { SigningSource } from '../lib/wallet-unlock';

/**
 * WHAT THE RUNNING `tenjin mcp` SAW, for the processes that cannot ask it.
 * Doctor runs in a shell, `alive` and the hooks run as their own processes,
 * and none of them can see the router Claude Code started: its environment,
 * its keychain answer, its verdict. So the router writes them down:
 *
 *   <dataDir>/router/live/<pid>.json     one per running `tenjin mcp`; removed on exit
 *   <dataDir>/router/unlock-state.json   the latest unlock verdict per address;
 *                                        survives the process
 *
 * Both are 0600 in a 0700 directory, and neither ever holds a passphrase, a
 * key, an env VALUE or a store's stdout: only whether a variable is set, the
 * address, the cwd and verdicts.
 *
 * A HEALTH-CHECK ROUTER IS NOT A SESSION (B2). `claude mcp get` and `claude mcp
 * list` start a `tenjin mcp` that serves no hook. Its observation says
 * `servedSession: false` until it serves a hook call carrying a valid
 * session_id, and every reader that means "the running Claude session" keeps
 * only `servedSession: true` ({@link servedObservations}). Only a served
 * router reads or writes unlock-state.
 *
 * Hook-safe: node, zod and `lib/atomic-json` only. Every reader treats any
 * I/O error as "absent", and the writers swallow theirs: these files are
 * advisory, and a router must never fail a lookup because it could not
 * describe itself.
 */

export interface RouterObservation {
  version: 1;
  pid: number;
  startedAt: number;
  at: number;
  cliVersion: string;
  harness: 'claude' | 'codex';
  launchedByPlugin: boolean;
  cwd: string;
  address: string | null;
  /** B2: false until this router has served a hook call carrying a valid session_id. Readers that mean
   *  "the running Claude session" ignore false. */
  servedSession: boolean;
  env: { passphraseSet: boolean; keySet: boolean };
  sign: {
    status: 'ready' | 'blocked' | 'unknown' | 'pending';
    reason?: string;
    detail?: string;
    fix?: string;
    source?: SigningSource;
  };
  routing?: { status: 'ready' | 'blocked' | 'unknown'; reason?: string; at: number };
  /** The host that started this router, as it named itself to the server:
   *  what readback reads to say whether picks can run in place there. */
  client?: { name: string; version: string };
  /** When the plugin's mod first asked this router to run a pick in place
   *  (`swap.ts`): proof the mod is loaded in that host. */
  swapAt?: number;
}

export interface UnlockInputs {
  envPassphraseSet: boolean;
  envKeySet: boolean;
  walletMtimeMs: number | null;
  sidecarMtimeMs: number | null;
  cliVersion: string;
}

export interface UnlockRecord {
  version: 1;
  address: string;
  status: 'ready' | 'blocked' | 'unknown' | 'awaiting_confirmation';
  reason?: string;
  at: number;
  inputs?: UnlockInputs;
}

const SIGNING_SOURCES = [
  'key-env',
  'passphrase-env',
  'keychain',
  'secret-service',
  'dpapi',
  'file',
  'legacy',
] as const;

const ObservationSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  startedAt: z.number(),
  at: z.number(),
  cliVersion: z.string(),
  harness: z.enum(['claude', 'codex']),
  launchedByPlugin: z.boolean(),
  cwd: z.string(),
  address: z.string().nullable(),
  servedSession: z.boolean(),
  env: z.object({ passphraseSet: z.boolean(), keySet: z.boolean() }),
  sign: z.object({
    status: z.enum(['ready', 'blocked', 'unknown', 'pending']),
    reason: z.string().optional(),
    detail: z.string().optional(),
    fix: z.string().optional(),
    source: z.enum(SIGNING_SOURCES).optional(),
  }),
  routing: z
    .object({
      status: z.enum(['ready', 'blocked', 'unknown']),
      reason: z.string().optional(),
      at: z.number(),
    })
    .optional(),
  client: z.object({ name: z.string().max(200), version: z.string().max(200) }).optional(),
  swapAt: z.number().optional(),
});

const UnlockRecordSchema = z.object({
  version: z.literal(1),
  address: z.string(),
  status: z.enum(['ready', 'blocked', 'unknown', 'awaiting_confirmation']),
  reason: z.string().optional(),
  at: z.number(),
  inputs: z
    .object({
      envPassphraseSet: z.boolean(),
      envKeySet: z.boolean(),
      walletMtimeMs: z.number().nullable(),
      sidecarMtimeMs: z.number().nullable(),
      cliVersion: z.string(),
    })
    .optional(),
});

/** The envelope; records are checked one at a time so one bad entry hides only itself. */
const UnlockStateSchema = z.object({
  version: z.literal(1),
  wallets: z.record(z.string(), z.unknown()),
});

const OBSERVATION_NAME = /^(\d+)\.json$/;
/** How far a ps start time may sit from the observation's before the pid is another process. */
const START_SLACK_MS = 2000;

/** Where the running routers' observations live. */
export function liveDir(dataDir: string): string {
  return join(dataDir, 'router', 'live');
}

function observationPath(dataDir: string, pid: number): string {
  return join(liveDir(dataDir), `${pid}.json`);
}

function unlockStatePath(dataDir: string): string {
  return join(dataDir, 'router', 'unlock-state.json');
}

/** Write this router's observation. Swallows errors: it is advisory. */
export async function writeObservation(dataDir: string, obs: RouterObservation): Promise<void> {
  try {
    await writeFileAtomic(observationPath(dataDir, obs.pid), JSON.stringify(obs) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // A router that cannot describe itself still routes.
  }
}

/** Remove a router's observation, synchronously, for the process 'exit' handler. */
export function removeObservationSync(dataDir: string, pid: number): void {
  try {
    rmSync(observationPath(dataDir, pid), { force: true });
  } catch {
    // Nothing to do at exit; pruneDeadObservations clears it later.
  }
}

/**
 * Unlink the observations whose pid is no longer alive: a router killed
 * without running its exit handler (SIGKILL, a crash) leaves its file behind.
 */
export async function pruneDeadObservations(
  dataDir: string,
  isAlive: (pid: number) => boolean = pidAlive,
): Promise<void> {
  const dir = liveDir(dataDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const match = OBSERVATION_NAME.exec(name);
    if (match === null) continue;
    if (isAlive(Number(match[1]))) continue;
    await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * Every well-formed observation on disk, shape-checked, with no liveness
 * filter (see {@link liveObservations}). Dropped: a file not named
 * `<digits>.json`, one whose `pid` is not its name, any version but 1, a
 * malformed shape, and one without a boolean `servedSession` (B2: an
 * observation that cannot say whether it served a session is not one).
 */
export async function readObservations(dataDir: string): Promise<RouterObservation[]> {
  const dir = liveDir(dataDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: RouterObservation[] = [];
  for (const name of names.sort()) {
    const match = OBSERVATION_NAME.exec(name);
    if (match === null) continue;
    try {
      const parsed = ObservationSchema.safeParse(
        JSON.parse(await readFile(join(dir, name), 'utf8')),
      );
      if (parsed.success && parsed.data.pid === Number(match[1])) {
        out.push(parsed.data as RouterObservation);
      }
    } catch {
      // Unreadable or not JSON: absent.
    }
  }
  return out;
}

/** The observations that count as a running Claude session: harness 'claude' and servedSession true (B2). */
export function servedObservations(obs: RouterObservation[]): RouterObservation[] {
  return obs.filter((o) => o.harness === 'claude' && o.servedSession === true);
}

/**
 * Keep the observations whose router is still running.
 *
 * With a ps snapshot, the pid must be a listed router (the snapshot lists only
 * live, non-zombie routers) whose start time is within 2 s of the
 * observation's own: a pid the OS has since handed to another router is not
 * this one. A listed router whose start time ps could not give (null) is kept
 * on the pid alone. Without a snapshot (null: ps could not run), `alive`.
 */
export function liveObservations(
  obs: RouterObservation[],
  routers: Array<{ pid: number; startedAt: number | null }> | null,
  alive: (pid: number) => boolean = pidAlive,
): RouterObservation[] {
  if (routers === null) return obs.filter((o) => alive(o.pid));
  return obs.filter((o) => {
    const router = routers.find((r) => r.pid === o.pid);
    if (router === undefined) return false;
    return router.startedAt === null || Math.abs(router.startedAt - o.startedAt) <= START_SLACK_MS;
  });
}

/**
 * Whether a process with this pid exists: `kill(pid, 0)` sends nothing and
 * only checks. EPERM means it exists under another user, so it counts as
 * alive; ESRCH (and anything else) as gone. Never true for a pid that is not
 * a positive integer, since `kill(0, …)` addresses the whole process group.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
}

async function readUnlockWallets(dataDir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = UnlockStateSchema.safeParse(
      JSON.parse(await readFile(unlockStatePath(dataDir), 'utf8')),
    );
    return parsed.success ? parsed.data.wallets : null;
  } catch {
    return null;
  }
}

/** The latest unlock record for `address` (any case), or null. */
export async function readUnlockRecord(
  dataDir: string,
  address: string,
): Promise<UnlockRecord | null> {
  const wallets = await readUnlockWallets(dataDir);
  if (wallets === null) return null;
  const parsed = UnlockRecordSchema.safeParse(wallets[address.toLowerCase()]);
  return parsed.success ? (parsed.data as UnlockRecord) : null;
}

/**
 * Record `rec` under its lowercase address, keeping every other address's
 * record. Swallows errors: unlock-state is advisory, and a repair that saved
 * the passphrase must not fail because this file could not be written. Two
 * routers writing at once can lose one update; the next verdict rewrites it.
 */
export async function writeUnlockRecord(dataDir: string, rec: UnlockRecord): Promise<void> {
  try {
    const wallets = { ...((await readUnlockWallets(dataDir)) ?? {}) };
    wallets[rec.address.toLowerCase()] = rec;
    await writeFileAtomic(
      unlockStatePath(dataDir),
      JSON.stringify({ version: 1, wallets }, null, 2) + '\n',
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch {
    // Advisory: see above.
  }
}

/**
 * After `tenjin wallet repair`: the next served router's verdict for this
 * address decides whether "Tenjin wallet unlocked." is said (decision 14).
 */
export async function markUnlockPending(
  dataDir: string,
  address: string,
  now: number = Date.now(),
): Promise<void> {
  await writeUnlockRecord(dataDir, {
    version: 1,
    address,
    status: 'awaiting_confirmation',
    at: now,
  });
}
