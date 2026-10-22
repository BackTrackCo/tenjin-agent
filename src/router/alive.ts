import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MAX_AUTO_SPEND } from '../lib/config';
import { configPath, walletPath } from '../lib/paths';
import {
  DEFAULT_RPC_URL,
  readUsdcBalanceWithFallback,
  rememberingBalanceReader,
} from '../lib/usdc-balance';

/**
 * THE PLUGIN SAYS IT IS HERE. While a machine carries both the plugin and the
 * settings install it replaces, every event would run two sets of routing legs
 * and offer the same lookup twice. The plugin's `SessionStart` entry runs
 * `tenjin hook alive` before any other event of the session, and it writes:
 *
 * - a per-session marker, which every leg a settings install launched checks
 *   first, staying silent in a session the plugin serves;
 * - a per-machine stamp, the proof the guarded migration waits for: the plugin
 *   has loaded in a real session on this machine at least once, so the
 *   settings install can be removed without leaving the machine unrouted.
 *
 * Outside `progress/`, whose files are pruned after ten minutes. Markers are
 * pruned here after a week, which outlasts any session that still matters.
 *
 * SHIM: the per-session check goes on or after 2026-12-01, the first release
 * cut 30 or more days after the plugin PR 2 ships; the stamp stays for doctor.
 */

const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP = 'plugin-loaded.json';
/** A session id names a file only through its hash, so any string is safe. */
const MAX_SESSION_ID = 200;

export function aliveDir(dataDir: string): string {
  return join(dataDir, 'alive');
}

function markerName(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function sessionIdOf(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null;
  const id = (event as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID ? id : null;
}

export interface AliveStamp {
  at: string;
  /** The CLI version whose plugin loaded. */
  version: string;
}

/**
 * The `alive` leg: marker, stamp, prune. It prints nothing, because a
 * `SessionStart` hook's plain stdout is added to the session's context
 * ({@link aliveMain} adds the wallet notice as JSON), and it never fails the
 * session: every error is swallowed.
 */
export async function runAliveHook(
  event: unknown,
  opts: { dataDir: string; version: string; now?: number },
): Promise<void> {
  const sessionId = sessionIdOf(event);
  const now = opts.now ?? Date.now();
  const dir = aliveDir(opts.dataDir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (sessionId !== null) {
      await writeFile(join(dir, markerName(sessionId)), `${new Date(now).toISOString()}\n`);
    }
    const stamp: AliveStamp = { at: new Date(now).toISOString(), version: opts.version };
    await writeFile(join(dir, STAMP), `${JSON.stringify(stamp)}\n`);
    await pruneMarkers(dir, now);
  } catch {
    // A marker that could not be written costs only a duplicate offer.
  }
}

async function pruneMarkers(dir: string, now: number): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s !== null && now - s.mtimeMs > MARKER_TTL_MS) await rm(path, { force: true });
  }
}

/** Has the plugin's `alive` leg marked this session? False on any doubt. */
export async function sessionServedByPlugin(dataDir: string, event: unknown): Promise<boolean> {
  const sessionId = sessionIdOf(event);
  if (sessionId === null) return false;
  return (await stat(join(aliveDir(dataDir), markerName(sessionId))).catch(() => null)) !== null;
}

/** The machine's stamp, or null when the plugin has never loaded here. */
export async function readAliveStamp(dataDir: string): Promise<AliveStamp | null> {
  try {
    const parsed = JSON.parse(await readFile(join(aliveDir(dataDir), STAMP), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const { at, version } = parsed as { at?: unknown; version?: unknown };
    return typeof at === 'string' && typeof version === 'string' ? { at, version } : null;
  } catch {
    return null;
  }
}

/** `uninstall`: the markers and the stamp, and nothing else under the data dir. */
export async function removeAliveState(dataDir: string): Promise<boolean> {
  const dir = aliveDir(dataDir);
  const existed = (await stat(dir).catch(() => null)) !== null;
  if (!existed) return false;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name === STAMP || /^[0-9a-f]{32}$/.test(name)) await rm(join(dir, name), { force: true });
  }
  // Only when empty: a file somebody else put there keeps the folder.
  await rmdir(dir).catch(() => undefined);
  return true;
}

/** How long the leg waits on a balance read before it says nothing. */
export const WALLET_READ_MS = 2_000;

/**
 * THE WALLET, SAID TO THE PERSON AT THE START OF A SESSION while it cannot
 * pay: the leg's `systemMessage`, which Claude Code shows the user and never
 * the model, on every surface and without the mod. Null when there is no
 * wallet, the balance could not be read in time, or the wallet holds at least
 * the per-call limit.
 */
export async function walletNotice(
  dataDir: string,
  opts: { read?: typeof readUsdcBalanceWithFallback; timeoutMs?: number } = {},
): Promise<string | null> {
  const wallet = await readJson(walletPath(dataDir));
  const address = typeof wallet?.address === 'string' ? wallet.address : undefined;
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const config = await readJson(configPath(dataDir));
  const rpcUrl = typeof config?.rpcUrl === 'string' ? config.rpcUrl : DEFAULT_RPC_URL;
  const timeoutMs = opts.timeoutMs ?? WALLET_READ_MS;
  const read = rememberingBalanceReader(dataDir, {
    ...(opts.read !== undefined ? { read: opts.read } : {}),
  });
  const balance = await read(address, rpcUrl, { timeoutMs });
  if (balance === null) return null;
  // The per-call limit as the spend policy reads it: the file's, else the default.
  const cap = BigInt(
    typeof config?.maxAutoSpend === 'string' && /^\d{1,30}$/.test(config.maxAutoSpend)
      ? config.maxAutoSpend
      : DEFAULT_MAX_AUTO_SPEND,
  );
  if (balance > 0n && balance >= cap) return null;
  // Only the person reads it, inside the session: they ask, the agent runs it.
  return `Tenjin balance: $${dollars(balance)}. Ask your agent to add $5 or more to Tenjin.`;
}

/** `$0.00`, `$0.10`, `$0.007`: whole cents keep two decimals. */
function dollars(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${atomic / 1_000_000n}.${fraction.padEnd(2, '0')}`;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The command form's entry, read off stdin: `tenjin hook alive`. It prints
 * only a JSON `systemMessage`, which Claude Code shows the user; plain text
 * would be added to the session's context.
 */
export async function aliveMain(opts: { dataDir: string; version: string }): Promise<void> {
  const raw = await readStdin(1_000).catch(() => '');
  await runAliveHook(parseEvent(raw), opts);
  const notice = await walletNotice(opts.dataDir).catch(() => null);
  if (notice !== null) process.stdout.write(`${JSON.stringify({ systemMessage: notice })}\n`);
}

function parseEvent(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('no harness event')), timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        clearTimeout(timer);
        reject(new Error('harness event too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.once('error', () => {
      clearTimeout(timer);
      reject(new Error('harness event unreadable'));
    });
  });
}

/**
 * A plugin leg marks its own session too, for a session that loaded the plugin
 * without a `SessionStart` (a `/reload-plugins` mid-session): from the next
 * event on, the settings install's legs there stay silent. A stat when the
 * marker is already there.
 */
export async function markSessionServed(dataDir: string, event: unknown): Promise<void> {
  const sessionId = sessionIdOf(event);
  if (sessionId === null) return;
  const path = join(aliveDir(dataDir), markerName(sessionId));
  if ((await stat(path).catch(() => null)) !== null) return;
  try {
    await mkdir(aliveDir(dataDir), { recursive: true, mode: 0o700 });
    await writeFile(path, `${new Date().toISOString()}\n`);
  } catch {
    // Costs only a duplicate offer.
  }
}
