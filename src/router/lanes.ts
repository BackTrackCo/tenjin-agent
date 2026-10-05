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
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { hasCode } from '../lib/errno';
import { formatUsdDisplay } from '../lib/money';

/**
 * THE ROUTING FEE'S LANES, as files. Every routing call on the paid path pays
 * $0.003 over x402 `batch-settlement`, and the server holds one pending request
 * per channel, so a payer keeps a small pool of channels ("lanes") and each
 * parallel call takes its own.
 *
 * ONE FOLDER PER WALLET. Each wallet's lanes, pool file, claims, fee lines
 * and voucher key live under `<lanes dir>/<lowercase payer address>/`, and the
 * owner names the wallet in use in `payer.json` beside them. A replaced wallet
 * gets lanes and a voucher key of its own; when the old wallet is in use again
 * its folder, and what its lanes still hold, comes back as it was.
 *
 * TWO KINDS OF WRITER, ONE RULE. The `tenjin mcp` process that holds a lane's
 * lease owns everything that needs the wallet: the deposit, the voucher key,
 * the pre-signed ladder of `PAYMENT-SIGNATURE` strings and the lane's fee lines
 * (`lane-owner.ts`). A hook only claims a lane, sends the rung the ladder
 * already holds, and writes what `PAYMENT-RESPONSE` said the channel has
 * charged. Every write to a lane's files happens under that lane's claim, so
 * the owner and a hook never write at once.
 *
 * NOTHING HERE SIGNS OR IMPORTS A PAYMENT LIBRARY. The hooks load this module,
 * and their chunk graph stays free of the wallet and the x402 SDK
 * (`dist-chunks.test.ts`). Reading the charged total out of `PAYMENT-RESPONSE`
 * is a base64 JSON read; the owner still hands the raw header to the SDK.
 */

export const ROUTE_PAID_PATH = '/api/x402-router/route';
export const ROUTE_CHANNEL_PATH = '/api/x402-router/channel';

/** The flat fee per routing call, atomic USDC ($0.003). */
export const ROUTING_FEE_ATOMIC = 3_000n;
/** One lane deposit or top-up, atomic USDC ($0.25): fits the installer's
 *  default per-call `maxAutoSpend`. */
export const LANE_DEPOSIT_ATOMIC = 250_000n;
/** The default routing allowance, atomic USDC per rolling 24 h ($0.50). */
export const ROUTING_ALLOWANCE_ATOMIC = 500_000n;
export const ROUTING_WINDOW_MS = 86_400_000;
/** Pre-signed rungs per lane. */
export const LADDER_RUNGS = 10;
/** Lanes per payer, shared by every session on this machine. */
export const MAX_LANES = 8;
/** A hook's claim on a lane expires on its own, so a killed hook strands nothing. */
export const HOOK_CLAIM_TTL_MS = 10_000;
/** The owner's claim covers a deposit, which waits on a settlement. */
export const OWNER_CLAIM_TTL_MS = 60_000;
/** A lease the owner stops renewing frees the lane for another process. */
export const LEASE_TTL_MS = 60_000;

const ATOMIC_RE = /^\d{1,30}$/;

/** One pre-signed voucher: the cumulative cap and the header that carries it. */
export interface Rung {
  maxClaimableAtomic: string;
  header: string;
}

/** What the owner writes about its lane. */
export interface LaneState {
  version: 1;
  index: number;
  /** The wallet whose channel this is, and whose folder the lane lives in. */
  payer: string;
  /** The SDK's client `salt`: one channel per lane for the same payer. */
  salt: string;
  channelId: string;
  /** What the channel holds on chain, as the last settle reported it. */
  balanceAtomic: string;
  /** What the server has charged so far, cumulative. */
  chargedAtomic: string;
  /** `recovering` until the owner has resynced after a corrective 402. */
  status: 'ready' | 'recovering';
  ladder: Rung[];
  updatedAtMs: number;
}

/** What a payer (hook or tool) writes after its call, under the claim. */
export interface LaneResult {
  version: 1;
  atMs: number;
  /** The channel's charged total after this call, as far as the payer knows. */
  chargedAtomic: string;
  /**
   * `charged` and `zero`: a `PAYMENT-RESPONSE` came back. `corrective`: a 402
   * the owner resyncs from. `unknown`: no answer (an abort, a dead socket), so
   * the next voucher finds out. `refused`: an answer that settles nothing.
   */
  outcome: 'charged' | 'zero' | 'corrective' | 'unknown' | 'refused';
  /** The raw headers, for the owner to hand to the SDK. */
  paymentResponse?: string;
  paymentRequired?: string;
}

/** `tenjin mcp` cannot open the voucher key without a prompt. */
export type OwnerBlocked = 'voucher_key_locked';

/**
 * What the server answers, for every wallet on the machine, in the lanes
 * directory itself. Advisory, last write wins.
 */
export interface PoolState {
  version: 1;
  /** Whether the server answers the paid routing path with a batch-settlement 402. */
  paidPath: 'available' | 'absent';
  checkedAtMs: number;
  /**
   * When the free path answered `fee_required`: the server routes only paid
   * calls now, so a machine without approval is paused. Cleared when the free
   * path routes again.
   */
  feeRequiredAtMs?: number | null;
}

/** What owners write about one wallet's lanes, in its folder. Advisory. */
export interface WalletPool {
  version: 1;
  /** Why the last funding attempt did not deposit, if it did not. */
  fundingBlocked?: 'wallet_low' | 'not_allowlisted' | null;
  /** Why the owner can service no lane at all, if it cannot. */
  ownerBlocked?: OwnerBlocked | null;
  walletBalanceAtomic?: string;
  /** When a payer last found no free lane, so an owner grows the pool. */
  demandAtMs?: number;
}

interface Claim {
  token: string;
  pid: number;
  expiresAtMs: number;
}

/** The lanes directory: the server's answers, `payer.json`, one folder per wallet. */
export function lanesDir(dataDir: string): string {
  return join(dataDir, 'router', 'lanes');
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const VOUCHER_KEY_FILE = 'voucher-key.json';

/** One wallet's folder: its lanes, pool file, claims, fee lines and voucher key. */
export function payerLanesDir(dataDir: string, payer: string): string {
  const name = payer.toLowerCase();
  if (!ADDRESS_RE.test(name)) throw new Error(`not a wallet address: ${payer}`);
  return join(lanesDir(dataDir), name);
}

/** Where a wallet's voucher key is kept, encrypted (`lib/wallet/voucher-key.ts`). */
export function voucherKeyPath(dataDir: string, payer: string): string {
  return join(payerLanesDir(dataDir, payer), VOUCHER_KEY_FILE);
}

function currentFile(dataDir: string): string {
  return join(lanesDir(dataDir), 'payer.json');
}

/**
 * The folder of the wallet the owner last found in use, or null before any
 * owner ran. The hooks never load the wallet, so this is how they find it.
 */
export async function currentLanesDir(dataDir: string): Promise<string | null> {
  const payer = ((await readJson(currentFile(dataDir))) as { payer?: unknown } | null)?.payer;
  return typeof payer === 'string' && ADDRESS_RE.test(payer) ? payerLanesDir(dataDir, payer) : null;
}

/** Name `payer` as the wallet in use, writing only on a change; its folder. */
export async function useLanesOf(dataDir: string, payer: string): Promise<string> {
  const dir = payerLanesDir(dataDir, payer);
  if ((await currentLanesDir(dataDir)) !== dir) {
    await writeJson(currentFile(dataDir), { version: 1, payer: payer.toLowerCase() });
  }
  return dir;
}

const file = {
  state: (dir: string, i: number) => join(dir, `lane-${i}.json`),
  claim: (dir: string, i: number) => join(dir, `lane-${i}.claim`),
  lease: (dir: string, i: number) => join(dir, `lane-${i}.lease`),
  result: (dir: string, i: number) => join(dir, `lane-${i}.result.json`),
  fees: (dir: string, i: number) => join(dir, `lane-${i}.fees.jsonl`),
  pool: (dir: string) => join(dir, 'pool.json'),
};
export const laneFiles = file;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 });
}

function isAtomic(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC_RE.test(value);
}

export function parseLaneState(value: unknown): LaneState | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<LaneState>;
  if (
    v.version !== 1 ||
    typeof v.index !== 'number' ||
    typeof v.payer !== 'string' ||
    typeof v.salt !== 'string' ||
    typeof v.channelId !== 'string' ||
    !isAtomic(v.balanceAtomic) ||
    !isAtomic(v.chargedAtomic) ||
    (v.status !== 'ready' && v.status !== 'recovering') ||
    !Array.isArray(v.ladder) ||
    typeof v.updatedAtMs !== 'number'
  ) {
    return null;
  }
  const ladder = v.ladder.filter(
    (r): r is Rung =>
      r !== null &&
      typeof r === 'object' &&
      isAtomic((r as Rung).maxClaimableAtomic) &&
      typeof (r as Rung).header === 'string',
  );
  return { ...(v as LaneState), ladder };
}

function parseResult(value: unknown): LaneResult | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<LaneResult>;
  return v.version === 1 && typeof v.atMs === 'number' && isAtomic(v.chargedAtomic)
    ? (v as LaneResult)
    : null;
}

export async function readLaneState(dir: string, index: number): Promise<LaneState | null> {
  return parseLaneState(await readJson(file.state(dir, index)));
}

export async function readLaneResult(dir: string, index: number): Promise<LaneResult | null> {
  return parseResult(await readJson(file.result(dir, index)));
}

export async function readPool(dataDir: string): Promise<PoolState | null> {
  const value = await readJson(file.pool(lanesDir(dataDir)));
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<PoolState>;
  if (v.version !== 1 || (v.paidPath !== 'available' && v.paidPath !== 'absent')) return null;
  // Only the server's answers: a flat-layout pool also held one wallet's.
  return {
    version: 1,
    paidPath: v.paidPath,
    checkedAtMs: typeof v.checkedAtMs === 'number' ? v.checkedAtMs : 0,
    ...(v.feeRequiredAtMs !== undefined ? { feeRequiredAtMs: v.feeRequiredAtMs } : {}),
  };
}

export async function writePool(dataDir: string, patch: Partial<PoolState>): Promise<void> {
  const prev = await readPool(dataDir);
  const next: PoolState = {
    version: 1,
    paidPath: 'absent',
    checkedAtMs: 0,
    ...(prev ?? {}),
    ...patch,
  };
  await writeJson(file.pool(lanesDir(dataDir)), next);
}

/** A wallet's pool file, from its folder. */
export async function readWalletPool(dir: string): Promise<WalletPool | null> {
  const value = await readJson(file.pool(dir));
  return value !== null && typeof value === 'object' && (value as WalletPool).version === 1
    ? (value as WalletPool)
    : null;
}

export async function writeWalletPool(dir: string, patch: Partial<WalletPool>): Promise<void> {
  const prev = await readWalletPool(dir);
  await writeJson(file.pool(dir), { ...(prev ?? {}), ...patch, version: 1 });
}

/** Indices of the lanes that have a state file, in order. */
export async function laneIndices(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^lane-(\d)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .filter((n) => n < MAX_LANES)
    .sort((a, b) => a - b);
}

/**
 * TAKE A LANE'S CLAIM, or say it is held. The claim is a file that appears
 * with its whole body or not at all; one past its expiry is moved aside and
 * re-taken. What was moved is checked against the claim that was read, so two
 * payers cannot both end up holding the lane: the one that moved any claim
 * other than the stale one it read puts it back and walks away.
 */
export async function takeClaim(
  dir: string,
  index: number,
  ttlMs: number,
  now: number,
): Promise<string | null> {
  const path = file.claim(dir, index);
  const token = randomUUID();
  const claim: Claim = { token, pid: process.pid, expiresAtMs: now + ttlMs };
  const body = JSON.stringify(claim);
  if (await createClaim(path, body)) return token;
  const held = (await readJson(path)) as Claim | null;
  if (held !== null && typeof held.expiresAtMs === 'number' && held.expiresAtMs > now) {
    return null;
  }
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return null;
  }
  const moved = (await readJson(aside)) as Claim | null;
  if (moved !== null && moved.token !== held?.token) {
    // Somebody took it between the read and the move: hand it back.
    await link(aside, path).catch(() => undefined);
    await rm(aside, { force: true });
    return null;
  }
  await rm(aside, { force: true });
  return (await createClaim(path, body)) ? token : null;
}

export async function dropClaim(dir: string, index: number, token: string): Promise<void> {
  const path = file.claim(dir, index);
  const held = (await readJson(path)) as Claim | null;
  if (held?.token === token) await rm(path, { force: true });
}

/**
 * A claim is written whole under a name of its own and then linked into place,
 * which fails when the claim exists. A reader never sees a claim without its
 * body, so it never takes a half-written claim for a stale one.
 */
async function createClaim(path: string, body: string): Promise<boolean> {
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

/** Why a lane cannot carry the next call, or the rung that it would send. */
export type LaneReadiness =
  | { ready: true; rung: Rung; chargedAtomic: bigint }
  | { ready: false; why: 'recovering' | 'below_fee' | 'ladder_spent' | 'unfunded' };

/**
 * THE NEXT RUNG, from the owner's state and the last payer's result. The server
 * checks that a voucher is exactly its charged total plus the fee, so the rung
 * to send is the one whose cap is the latest known charged total plus one fee.
 * A call the server settled at $0 leaves the total where it was, and the same
 * rung goes again: a voucher carries no nonce.
 */
export function laneReadiness(state: LaneState, result: LaneResult | null): LaneReadiness {
  const fresh = result !== null && result.atMs >= state.updatedAtMs ? result : null;
  if (state.status === 'recovering' || fresh?.outcome === 'corrective') {
    return { ready: false, why: 'recovering' };
  }
  const balance = BigInt(state.balanceAtomic);
  if (balance === 0n) return { ready: false, why: 'unfunded' };
  const charged = BigInt(fresh?.chargedAtomic ?? state.chargedAtomic);
  if (balance - charged < ROUTING_FEE_ATOMIC) return { ready: false, why: 'below_fee' };
  const want = (charged + ROUTING_FEE_ATOMIC).toString();
  const rung = state.ladder.find((r) => r.maxClaimableAtomic === want);
  return rung === undefined
    ? { ready: false, why: 'ladder_spent' }
    : { ready: true, rung, chargedAtomic: charged };
}

/** A lane the caller now holds, with the header to send. */
export interface HeldLane {
  index: number;
  header: string;
  chargedAtomic: bigint;
  /** Write what the call came back with, and let the lane go. */
  finish: (answer: PaidAnswer) => Promise<void>;
}

/** How a paid call ended, in the terms the result file needs. */
export type PaidAnswer =
  | { kind: 'answered'; status: number; paymentResponse?: string }
  | { kind: 'payment_required'; paymentRequired?: string }
  | { kind: 'no_answer' };

/** Why no lane was taken. */
export type NoLane = 'no_lanes' | 'busy' | 'recovering' | 'below_fee' | 'allowance';

/**
 * CLAIM A LANE THAT CAN PAY ONE FEE NOW, or say why none can. Lanes are tried
 * from a random start, so parallel payers spread over the pool instead of
 * queueing on lane 0. `prefer` puts some lanes first (the tool's own).
 *
 * THE ALLOWANCE IS CHECKED ONCE, BEFORE ANY LANE IS CLAIMED. A payer's fee
 * counts from the moment its call writes its result, so payers that check at
 * the same time can each pay one more fee: the allowance can go over by at
 * most one fee per lane, because a lane carries one call at a time.
 */
export async function claimLane(
  dataDir: string,
  opts: { now: number; ttlMs?: number; allowanceAtomic: bigint; prefer?: readonly number[] },
): Promise<{ lane: HeldLane } | { lane: null; why: NoLane }> {
  const dir = await currentLanesDir(dataDir);
  const indices = dir === null ? [] : await laneIndices(dir);
  if (dir === null || indices.length === 0) return { lane: null, why: 'no_lanes' };
  const spent = await feesIn(dir, opts.now);
  if (spent + ROUTING_FEE_ATOMIC > opts.allowanceAtomic) return { lane: null, why: 'allowance' };
  const start = Math.floor(Math.random() * indices.length);
  const rotated = [...indices.slice(start), ...indices.slice(0, start)];
  const preferred = new Set(opts.prefer ?? []);
  const order = [
    ...rotated.filter((i) => preferred.has(i)),
    ...rotated.filter((i) => !preferred.has(i)),
  ];
  let why: NoLane = 'busy';
  let allHeld = true;
  for (const index of order) {
    const token = await takeClaim(dir, index, opts.ttlMs ?? HOOK_CLAIM_TTL_MS, opts.now);
    if (token === null) continue;
    allHeld = false;
    const state = await readLaneState(dir, index);
    const readiness =
      state === null ? null : laneReadiness(state, await readLaneResult(dir, index));
    if (readiness === null || !readiness.ready) {
      await dropClaim(dir, index, token);
      if (readiness?.why === 'recovering') why = 'recovering';
      else if (readiness?.why === 'below_fee' && why !== 'recovering') why = 'below_fee';
      continue;
    }
    const before = readiness.chargedAtomic;
    return {
      lane: {
        index,
        header: readiness.rung.header,
        chargedAtomic: before,
        finish: async (answer) => {
          try {
            await recordAnswer(dir, index, before, answer, opts.now);
          } finally {
            await dropClaim(dir, index, token);
          }
        },
      },
    };
  }
  // Only a pool whose every lane another payer holds is short of lanes; one
  // that is recovering, unfunded or below a fee would gain only unfunded lanes.
  if (allHeld) await notePoolDemand(dir, opts.now);
  return { lane: null, why };
}

async function notePoolDemand(dir: string, now: number): Promise<void> {
  try {
    await writeWalletPool(dir, { demandAtMs: now });
  } catch {
    // A hint for the owners; losing it delays one lane.
  }
}

async function recordAnswer(
  dir: string,
  index: number,
  before: bigint,
  answer: PaidAnswer,
  atMs: number,
): Promise<void> {
  let result: LaneResult;
  if (answer.kind === 'payment_required') {
    result = {
      version: 1,
      atMs,
      chargedAtomic: before.toString(),
      outcome: 'corrective',
      ...(answer.paymentRequired !== undefined ? { paymentRequired: answer.paymentRequired } : {}),
    };
  } else if (answer.kind === 'no_answer') {
    result = { version: 1, atMs, chargedAtomic: before.toString(), outcome: 'unknown' };
  } else {
    const charged =
      answer.paymentResponse !== undefined ? chargedFrom(answer.paymentResponse) : null;
    if (charged === null) {
      result = {
        version: 1,
        atMs,
        chargedAtomic: before.toString(),
        // An answer under 400 settles; without a readable PAYMENT-RESPONSE the
        // next voucher finds out where the channel stands.
        outcome: answer.status < 400 ? 'unknown' : 'refused',
      };
    } else {
      result = {
        version: 1,
        atMs,
        chargedAtomic: charged.toString(),
        outcome: charged > before ? 'charged' : 'zero',
        paymentResponse: answer.paymentResponse as string,
      };
    }
  }
  await writeJson(file.result(dir, index), result);
}

/**
 * The charged total a `PAYMENT-RESPONSE` reports, or null. The header is the
 * standard base64 JSON settle response; `extra.channelState` is where the
 * batch-settlement server puts the channel's totals.
 */
export function chargedFrom(header: string): bigint | null {
  try {
    const settle = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      success?: unknown;
      extra?: { channelState?: { chargedCumulativeAmount?: unknown } };
    };
    if (settle.success !== true) return null;
    const value = settle.extra?.channelState?.chargedCumulativeAmount;
    const text = typeof value === 'number' ? String(value) : value;
    return typeof text === 'string' && ATOMIC_RE.test(text) ? BigInt(text) : null;
  } catch {
    return null;
  }
}

/**
 * ONE LINE PER FEE, WRITTEN BY THE LANE OWNER ALONE: what a pass found the
 * channel charged above the total the lane state last held. The state then
 * moves to the new total, so each charge is written once, whether a payer's
 * `PAYMENT-RESPONSE` or a recovery reported it.
 */
export interface FeeEntry {
  atMs: number;
  feeAtomic: bigint;
}

/**
 * Fees the wallet in use charged across its lanes in the rolling window: the
 * owner's lines, plus what payers reported since the owner last folded a
 * lane's result.
 */
export async function feesInWindow(dataDir: string, now: number): Promise<bigint> {
  const dir = await currentLanesDir(dataDir);
  return dir === null ? 0n : feesIn(dir, now);
}

async function feesIn(dir: string, now: number): Promise<bigint> {
  let total = 0n;
  for (const index of await laneIndices(dir)) {
    for (const e of await readFees(dir, index)) {
      if (now - e.atMs < ROUTING_WINDOW_MS) total += e.feeAtomic;
    }
    total += await unfoldedFees(dir, index);
  }
  return total;
}

/** What a payer's result says the channel charged above the lane state. */
async function unfoldedFees(dir: string, index: number): Promise<bigint> {
  const state = await readLaneState(dir, index);
  const result = await readLaneResult(dir, index);
  if (state === null || result === null || result.atMs < state.updatedAtMs) return 0n;
  const added = BigInt(result.chargedAtomic) - BigInt(state.chargedAtomic);
  return added > 0n ? added : 0n;
}

export function feeLines(entries: readonly FeeEntry[]): string {
  return entries
    .map((e) => `${JSON.stringify({ atMs: e.atMs, feeAtomic: e.feeAtomic.toString() })}\n`)
    .join('');
}

export async function appendFee(dir: string, index: number, entry: FeeEntry): Promise<void> {
  await appendFile(file.fees(dir, index), feeLines([entry]), { mode: 0o600 });
}

export async function readFees(dir: string, index: number): Promise<FeeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file.fees(dir, index), 'utf8');
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

/** Why routing on the paid path is paused, for doctor and the session notice. */
export type PausedReason =
  | { reason: 'approval_missing' }
  | { reason: 'cannot_fund'; walletAtomic: bigint | null }
  | { reason: OwnerBlocked };

/**
 * PAUSED, AND WHY. Only once the server takes the fee, which a machine learns
 * from the paid path's answer (an owner probes it after approval) or from the
 * free path answering `fee_required` (before approval, when no owner probes):
 * until then the free path routes as it always has, and there is nothing to
 * tell anyone. Missing approval pauses routing; an approved machine whose
 * lanes are all below one fee and whose wallet cannot make the next deposit is
 * paused for want of funds, and one whose owner cannot open the voucher key is
 * paused for that. Lanes and funding are the wallet in use's.
 */
export async function pausedReason(
  dataDir: string,
  approved: boolean,
): Promise<PausedReason | null> {
  const pool = await readPool(dataDir);
  if (pool === null) return null;
  const feeTaken = pool.paidPath === 'available' || typeof pool.feeRequiredAtMs === 'number';
  if (!feeTaken) return null;
  if (!approved) return { reason: 'approval_missing' };
  if (pool.paidPath !== 'available') return null;
  const dir = await currentLanesDir(dataDir);
  if (dir === null) return null;
  const wallet = await readWalletPool(dir);
  if (wallet?.ownerBlocked === 'voucher_key_locked') return { reason: wallet.ownerBlocked };
  if (wallet?.fundingBlocked !== 'wallet_low') return null;
  for (const index of await laneIndices(dir)) {
    const state = await readLaneState(dir, index);
    if (state === null) continue;
    const readiness = laneReadiness(state, await readLaneResult(dir, index));
    if (readiness.ready || readiness.why === 'recovering' || readiness.why === 'ladder_spent') {
      return null;
    }
  }
  return {
    reason: 'cannot_fund',
    walletAtomic: isAtomic(wallet.walletBalanceAtomic) ? BigInt(wallet.walletBalanceAtomic) : null,
  };
}

export const APPROVE_COMMAND = 'tenjin config set routingFee approved';

/**
 * Note whether the free path answered `fee_required`, writing the pool only
 * when that changes, so a hook adds no write on an ordinary call.
 */
export async function noteFeeRequired(
  dataDir: string,
  required: boolean,
  now: number,
): Promise<void> {
  const pool = await readPool(dataDir);
  if (required === (typeof pool?.feeRequiredAtMs === 'number')) return;
  await writePool(dataDir, { feeRequiredAtMs: required ? now : null });
}

/** The variable the wallet already reads its passphrase from, headless. */
export const PASSPHRASE_ENV = 'TENJIN_WALLET_PASSPHRASE';

/** The fix as one sentence. */
export function pausedFix(paused: PausedReason): string {
  switch (paused.reason) {
    case 'approval_missing':
      return `Run \`${APPROVE_COMMAND}\`.`;
    case 'cannot_fund':
      return `Run \`tenjin wallet fund ${usd(fundNeed(paused.walletAtomic))}\`.`;
    case 'voucher_key_locked':
      return `Set ${PASSPHRASE_ENV} to the wallet's passphrase (with a TENJIN_WALLET_KEY wallet, to a passphrase you keep) in the environment Claude Code starts from, then restart Claude Code.`;
  }
}

function fundNeed(walletAtomic: bigint | null): bigint {
  return walletAtomic === null || walletAtomic >= LANE_DEPOSIT_ATOMIC
    ? LANE_DEPOSIT_ATOMIC
    : LANE_DEPOSIT_ATOMIC - walletAtomic;
}

/** The one sentence doctor, the session notice and the tool share. */
export function pausedSentence(paused: PausedReason): string {
  switch (paused.reason) {
    case 'approval_missing':
      return `Tenjin routing is paused: the routing fee ($${usd(ROUTING_FEE_ATOMIC)} a call, at most $${usd(ROUTING_ALLOWANCE_ATOMIC)} a day) is not approved. To turn it back on, run \`${APPROVE_COMMAND}\`.`;
    case 'cannot_fund':
      return `Tenjin routing is paused: the wallet cannot fund a $${usd(LANE_DEPOSIT_ATOMIC)} routing lane. To turn it back on, fund it with \`tenjin wallet fund ${usd(fundNeed(paused.walletAtomic))}\`.`;
    case 'voucher_key_locked':
      return `Tenjin routing is paused: \`tenjin mcp\` cannot open the routing voucher key, which is sealed with the wallet passphrase, without a prompt. To turn it back on, set ${PASSPHRASE_ENV} in the environment Claude Code starts from and restart Claude Code.`;
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

/** The routing fee as `tenjin status` and `tenjin payments fees` show it, for the wallet in use. */
export interface FeeSummary {
  lanes: { index: number; depositedAtomic: string; chargedAtomic: string; status: string }[];
  /** Everything the server has charged across the lanes, all time. */
  chargedAtomic: string;
  /** What the lanes still hold for future fees. */
  creditAtomic: string;
  /** Fees charged in the rolling 24 h window. */
  windowAtomic: string;
}

export async function feeSummary(dataDir: string, now: number): Promise<FeeSummary> {
  const dir = await currentLanesDir(dataDir);
  const lanes: FeeSummary['lanes'] = [];
  let charged = 0n;
  let credit = 0n;
  if (dir === null) return { lanes, chargedAtomic: '0', creditAtomic: '0', windowAtomic: '0' };
  for (const index of await laneIndices(dir)) {
    const state = await readLaneState(dir, index);
    if (state === null) continue;
    const result = await readLaneResult(dir, index);
    const latest =
      result !== null && result.atMs >= state.updatedAtMs
        ? BigInt(result.chargedAtomic)
        : BigInt(state.chargedAtomic);
    const balance = BigInt(state.balanceAtomic);
    charged += latest;
    if (balance > latest) credit += balance - latest;
    lanes.push({
      index,
      depositedAtomic: state.balanceAtomic,
      chargedAtomic: latest.toString(),
      status: state.status,
    });
  }
  return {
    lanes,
    chargedAtomic: charged.toString(),
    creditAtomic: credit.toString(),
    windowAtomic: (await feesIn(dir, now)).toString(),
  };
}

/**
 * THE FLAT LAYOUT, MOVED INTO ITS PAYER'S FOLDER. Builds before the per-wallet
 * folders kept one wallet's lanes and voucher key straight in the lanes
 * directory. Everything moves by rename, never by copy: the voucher key first,
 * into the folder of the payer the lanes name (with no lane to name one, the
 * wallet in use), then each lane's files into its payer's folder with the
 * state file last, so a crash part way leaves the state where the next run
 * finds it and moves the rest. A file the target folder already has is left
 * where it is, never overwritten. Running it again changes nothing.
 */
export async function migrateFlatLanes(dataDir: string, walletInUse: string): Promise<void> {
  const root = lanesDir(dataDir);
  const lanes: { index: number; dir: string }[] = [];
  for (const index of await laneIndices(root)) {
    const state = await readLaneState(root, index);
    if (state === null || !ADDRESS_RE.test(state.payer.toLowerCase())) continue;
    lanes.push({ index, dir: payerLanesDir(dataDir, state.payer) });
  }
  await moveIfFree(
    join(root, VOUCHER_KEY_FILE),
    join(lanes[0]?.dir ?? payerLanesDir(dataDir, walletInUse), VOUCHER_KEY_FILE),
  );
  for (const { index, dir } of lanes) {
    if (await exists(file.state(dir, index))) continue;
    for (const name of [file.fees, file.result, file.lease, file.claim, file.state]) {
      await moveIfFree(name(root, index), name(dir, index));
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function moveIfFree(from: string, to: string): Promise<void> {
  if (!(await exists(from)) || (await exists(to))) return;
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err;
  }
}
