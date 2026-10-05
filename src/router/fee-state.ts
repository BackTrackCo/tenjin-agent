import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { hasCode } from '../lib/errno';
import { formatUsdDisplay } from '../lib/money';

/**
 * THE ROUTING FEE'S LOCAL FILES, and nothing that pays. Every routing call on
 * the paid path pays $0.003 over x402 `batch-settlement`, and the stock SDK
 * client in `tenjin mcp` does all of it (`routing-payer.ts`): it signs, keeps
 * each channel in the SDK's own file storage, deposits inline and recovers.
 * What is here is what the SDK does not keep:
 *
 * - the SLOT LEASES: one channel slot per `tenjin mcp` process, so the SDK's
 *   file storage has one writer per channel;
 * - the FEE LINES: the rolling 24 h routing allowance, one file per slot,
 *   written only by the process that holds the slot;
 * - the STATE FILE: whether the server answers the paid path, a `fee_required`
 *   answer from the free path, and why paying is paused, for `doctor`, the
 *   session notice and the readouts.
 *
 * NOTHING HERE SIGNS OR IMPORTS A PAYMENT LIBRARY: `tenjin hook` loads this
 * module, and its chunk graph stays free of the wallet and the x402 SDK
 * (`dist-chunks.test.ts`).
 */

export const ROUTE_PAID_PATH = '/api/x402-router/route';

/** The flat fee per routing call, atomic USDC ($0.003). */
export const ROUTING_FEE_ATOMIC = 3_000n;
/** One channel deposit, atomic USDC ($0.25), made inline by the SDK on the
 *  first paid call of a channel that cannot cover the next fee. */
export const CHANNEL_DEPOSIT_ATOMIC = 250_000n;
/** The default routing allowance, atomic USDC per rolling 24 h ($0.50). */
export const ROUTING_ALLOWANCE_ATOMIC = 500_000n;
export const ROUTING_WINDOW_MS = 86_400_000;
/** Channel slots per wallet: one per `tenjin mcp` process that pays. */
export const MAX_SLOTS = 8;

const ATOMIC_RE = /^\d{1,30}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** `<dataDir>/router/fee`: the state file and one folder per wallet. */
export function feeDir(dataDir: string): string {
  return join(dataDir, 'router', 'fee');
}

/** One wallet's folder: its slot leases, its fee lines and the SDK's channel
 *  files (`client/<channelId>.json`). */
export function payerDir(dataDir: string, payer: string): string {
  const name = payer.toLowerCase();
  if (!ADDRESS_RE.test(name)) throw new Error(`not a wallet address: ${payer}`);
  return join(feeDir(dataDir), name);
}

/** Why the payer could not pay, when it could not. */
export type PayBlocked = 'wallet_locked' | 'wallet_low' | 'not_allowlisted';

/** What `tenjin mcp` processes write about the paid path. Advisory, last
 *  write wins, written only on a change. */
export interface FeeState {
  version: 1;
  /** Whether the server answers the paid routing path with a batch-settlement 402. */
  paidPath?: 'available' | 'absent';
  checkedAtMs?: number;
  /** When the free path answered `fee_required`, cleared when it routes again. */
  feeRequiredAtMs?: number | null;
  /** The wallet that paid last, so the readouts know whose channels to show. */
  payer?: string;
  blocked?: PayBlocked | null;
  walletBalanceAtomic?: string;
}

function stateFile(dataDir: string): string {
  return join(feeDir(dataDir), 'state.json');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function isAtomic(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC_RE.test(value);
}

export async function readFeeState(dataDir: string): Promise<FeeState | null> {
  const value = await readJson(stateFile(dataDir));
  if (value === null || typeof value !== 'object') return null;
  const v = value as FeeState;
  return v.version === 1 ? v : null;
}

/** Merge `patch` into the state file, writing only when something changes. */
export async function writeFeeState(dataDir: string, patch: Partial<FeeState>): Promise<void> {
  const prev = (await readFeeState(dataDir)) ?? { version: 1 };
  const next: FeeState = { ...prev, ...patch, version: 1 };
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  await writeFileAtomic(stateFile(dataDir), `${JSON.stringify(next)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** Note whether the free path answered `fee_required`, writing only on a change. */
export async function noteFeeRequired(
  dataDir: string,
  required: boolean,
  now: number,
): Promise<void> {
  const state = await readFeeState(dataDir);
  if (required === (typeof state?.feeRequiredAtMs === 'number')) return;
  await writeFeeState(dataDir, { feeRequiredAtMs: required ? now : null });
}

/**
 * ONE SLOT, ONE PROCESS. The lease is a file holding the process id and a
 * token, created whole or not at all. A lease whose process is gone is moved
 * aside and re-taken; what was moved is checked against the lease that was
 * read, so two processes cannot both end up holding the slot: the one that
 * moved a live lease puts it back and walks away. No renewal and no expiry:
 * a live process keeps its slot, and an exit (or a kill) frees it.
 */
export interface SlotLease {
  pid: number;
  token: string;
}

function leaseFile(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.lease`);
}

export async function takeSlot(
  dir: string,
  slot: number,
  pid: number,
  isAlive: (pid: number) => boolean,
): Promise<string | null> {
  const path = leaseFile(dir, slot);
  const token = randomUUID();
  const body = JSON.stringify({ pid, token } satisfies SlotLease);
  if (await createWhole(path, body)) return token;
  const held = (await readJson(path)) as SlotLease | null;
  if (held !== null && typeof held.pid === 'number' && isAlive(held.pid)) return null;
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return null;
  }
  const moved = (await readJson(aside)) as SlotLease | null;
  if (moved !== null && moved.token !== held?.token) {
    // Somebody took it between the read and the move: hand it back.
    await link(aside, path).catch(() => undefined);
    await rm(aside, { force: true });
    return null;
  }
  await rm(aside, { force: true });
  return (await createWhole(path, body)) ? token : null;
}

/** Whether this token still holds the slot. */
export async function holdsSlot(dir: string, slot: number, token: string): Promise<boolean> {
  return ((await readJson(leaseFile(dir, slot))) as SlotLease | null)?.token === token;
}

export async function dropSlot(dir: string, slot: number, token: string): Promise<void> {
  if (await holdsSlot(dir, slot, token)) await rm(leaseFile(dir, slot), { force: true });
}

/** Whether a process id is running. EPERM is a live process of another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
}

/**
 * Written whole under a name of its own, then linked into place, which fails
 * when the target exists: a reader never sees a lease without its body.
 */
async function createWhole(path: string, body: string): Promise<boolean> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const draft = `${path}.${randomUUID()}.tmp`;
  await writeFile(draft, body, { flag: 'wx', mode: 0o600 });
  try {
    await link(draft, path);
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  } finally {
    await rm(draft, { force: true });
  }
}

/** One fee the SDK's charged total moved by on a paid call. */
export interface FeeEntry {
  atMs: number;
  feeAtomic: bigint;
}

function feeFile(dir: string, slot: number): string {
  return join(dir, `fees-${slot}.jsonl`);
}

function feeLines(entries: readonly FeeEntry[]): string {
  return entries
    .map((e) => `${JSON.stringify({ atMs: e.atMs, feeAtomic: e.feeAtomic.toString() })}\n`)
    .join('');
}

async function readFeeFile(path: string): Promise<FeeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: FeeEntry[] = [];
  for (const line of raw.split('\n')) {
    try {
      const v = JSON.parse(line) as { atMs?: unknown; feeAtomic?: unknown };
      if (typeof v.atMs === 'number' && isAtomic(v.feeAtomic)) {
        out.push({ atMs: v.atMs, feeAtomic: BigInt(v.feeAtomic) });
      }
    } catch {
      // A torn last line is skipped.
    }
  }
  return out;
}

/**
 * ONE FEE LINE, BY THE SLOT'S HOLDER ALONE. Lines past the window are dropped
 * on the way, so the file holds about one day of fees.
 */
export async function appendFee(
  dir: string,
  slot: number,
  entry: FeeEntry,
  now: number,
): Promise<void> {
  const path = feeFile(dir, slot);
  const fees = await readFeeFile(path);
  const kept = fees.filter((f) => now - f.atMs < ROUTING_WINDOW_MS);
  if (kept.length !== fees.length) {
    await writeFileAtomic(path, feeLines([...kept, entry]), { mode: 0o600, dirMode: 0o700 });
    return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(path, feeLines([entry]), { mode: 0o600 });
}

/** Fees one wallet paid across its slots in the rolling window. */
export async function feesInWindowFor(dir: string, now: number): Promise<bigint> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0n;
  }
  let total = 0n;
  for (const name of names.filter((n) => /^fees-\d+\.jsonl$/.test(n))) {
    for (const e of await readFeeFile(join(dir, name))) {
      if (now - e.atMs < ROUTING_WINDOW_MS) total += e.feeAtomic;
    }
  }
  return total;
}

/** The folder of the wallet that paid last, or null before any paid call. */
export async function currentPayerDir(dataDir: string): Promise<string | null> {
  const payer = (await readFeeState(dataDir))?.payer;
  return typeof payer === 'string' && ADDRESS_RE.test(payer) ? payerDir(dataDir, payer) : null;
}

/** Fees the wallet that paid last paid in the rolling window. */
export async function feesInWindow(dataDir: string, now: number): Promise<bigint> {
  const dir = await currentPayerDir(dataDir);
  return dir === null ? 0n : feesInWindowFor(dir, now);
}

/** Why routing on the paid path is paused, for doctor and the session notice. */
export type PausedReason =
  | { reason: 'approval_missing' }
  | { reason: 'cannot_fund'; walletAtomic: bigint | null }
  | { reason: 'wallet_locked' };

/**
 * PAUSED, AND WHY. Missing approval pauses routing only once the free path
 * answers `fee_required`: until then it routes as it always has, even on a
 * machine that knows the paid path. An approved machine that knows the paid
 * path, and whose wallet cannot make the next deposit or whose wallet
 * `tenjin mcp` cannot unlock, is paused for that.
 */
export async function pausedReason(
  dataDir: string,
  approved: boolean,
): Promise<PausedReason | null> {
  const state = await readFeeState(dataDir);
  if (state === null) return null;
  // Without approval only the free path runs, so only its `fee_required`
  // answer pauses routing: a remembered paid path does not.
  if (!approved) {
    return typeof state.feeRequiredAtMs === 'number' ? { reason: 'approval_missing' } : null;
  }
  if (state.paidPath !== 'available') return null;
  if (state.blocked === 'wallet_locked') return { reason: 'wallet_locked' };
  if (state.blocked !== 'wallet_low') return null;
  return {
    reason: 'cannot_fund',
    walletAtomic: isAtomic(state.walletBalanceAtomic) ? BigInt(state.walletBalanceAtomic) : null,
  };
}

export const APPROVE_COMMAND = 'tenjin config set routingFee approved';

/** The variable the wallet already reads its passphrase from, headless. */
export const PASSPHRASE_ENV = 'TENJIN_WALLET_PASSPHRASE';

/** The fix as one sentence. */
export function pausedFix(paused: PausedReason): string {
  switch (paused.reason) {
    case 'approval_missing':
      return `Run \`${APPROVE_COMMAND}\`.`;
    case 'cannot_fund':
      return `Run \`tenjin wallet fund ${usd(fundNeed(paused.walletAtomic))}\`.`;
    case 'wallet_locked':
      return `Set ${PASSPHRASE_ENV} to the wallet's passphrase in the environment Claude Code starts from, then restart Claude Code.`;
  }
}

function fundNeed(walletAtomic: bigint | null): bigint {
  return walletAtomic === null || walletAtomic >= CHANNEL_DEPOSIT_ATOMIC
    ? CHANNEL_DEPOSIT_ATOMIC
    : CHANNEL_DEPOSIT_ATOMIC - walletAtomic;
}

/** The one sentence doctor, the session notice and the tool share. */
export function pausedSentence(paused: PausedReason): string {
  switch (paused.reason) {
    case 'approval_missing':
      return `Tenjin routing is paused: the routing fee ($${usd(ROUTING_FEE_ATOMIC)} a call, at most $${usd(ROUTING_ALLOWANCE_ATOMIC)} a day) is not approved. To turn it back on, run \`${APPROVE_COMMAND}\`.`;
    case 'cannot_fund':
      return `Tenjin routing is paused: the wallet cannot fund a $${usd(CHANNEL_DEPOSIT_ATOMIC)} routing channel deposit. To turn it back on, fund it with \`tenjin wallet fund ${usd(fundNeed(paused.walletAtomic))}\`.`;
    case 'wallet_locked':
      return `Tenjin routing is paused: \`tenjin mcp\` cannot unlock the wallet without a prompt, so it signs neither routing fees nor provider payments. To turn it back on, set ${PASSPHRASE_ENV} in the environment Claude Code starts from and restart Claude Code.`;
  }
}

/** Atomic USDC as dollars with at least two decimals, never a float. */
export function usd(atomic: bigint): string {
  return formatUsdDisplay(atomic.toString());
}

/** How long a session's notice marker is kept. */
const NOTICE_KEEP_MS = 7 * ROUTING_WINDOW_MS;

/**
 * TRUE ONCE PER SESSION: the first caller for a session id creates its marker
 * and gets true; every later one gets false. Each marker holds the time it was
 * made, and those older than a week go on the way past, so the directory does
 * not grow with every session ever run.
 */
export async function firstNoticeFor(
  dataDir: string,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const dir = join(dataDir, 'router', 'notices');
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  const created = await createExclusive(join(dir, name), String(now));
  if (created) {
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, entry);
      const at = Number(await readFile(path, 'utf8').catch(() => 'NaN'));
      if (!Number.isFinite(at) || now - at > NOTICE_KEEP_MS) await rm(path, { force: true });
    }
  }
  return created;
}

async function createExclusive(path: string, body: string): Promise<boolean> {
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}
