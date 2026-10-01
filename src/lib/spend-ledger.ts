import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { hasCode } from './errno';
import { spendLedgerPath } from './paths';

/**
 * The spend ledger's READ side: its shape, the two expiries, and a read-only
 * summary. It lives outside `lib/wallet` so the router hooks can measure an
 * offer against the same session total an authorization would, without the
 * wallet entering their chunk graph (`src/router/dist-chunks.test.ts`). The
 * write side, with its lock and reservations, stays in `lib/wallet/spend.ts`.
 */

export const DEFAULT_WINDOW_MS = 86_400_000; // 24h rolling day
export const RESERVATION_TTL_MS = 600_000; // 10 min: a dangling reservation self-expires

const ReservationSchema = z.object({
  id: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
  /** Optional so a ledger written by an older build still parses. */
  requestKey: z.string().optional(),
  mode: z.enum(['automatic', 'manual']).optional(),
});
export type Reservation = z.infer<typeof ReservationSchema>;

const DurableSpendSchema = z.object({
  id: z.string(),
  requestKey: z.string(),
  runId: z.string(),
  runMaxAtomic: z.string().regex(/^\d+$/),
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
  /**
   * `reserved`: admitted, nothing signed. `signed`: an authorization left and no
   * validated provider response came back, so the money is unresolved and stays
   * charged across every window. `settled`: the provider answered with a valid
   * evaluation for it, so it was counted in that day's window like any other
   * payment and no longer charges later windows.
   */
  state: z.enum(['reserved', 'signed', 'settled']),
  /** Set on a compacted record: how many settled evaluations it stands for. */
  count: z.number().int().positive().optional(),
});
export type DurableSpend = z.infer<typeof DurableSpendSchema>;

/**
 * ONE TRANSMITTED AUTHORIZATION, by its EIP-3009 nonce: what it exposed and
 * when, so a payment the chain later proves was never charged can give back
 * exactly its own amount inside the window it was counted in.
 */
const ExposureSchema = z.object({
  nonce: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
  mode: z.enum(['automatic', 'manual']).optional(),
});
export type Exposure = z.infer<typeof ExposureSchema>;

const LedgerSchema = z.object({
  schemaVersion: z.literal(2),
  windowStartMs: z.number(),
  /**
   * EXPOSURE: every authorization this window transmitted. A signed EIP-3009
   * authorization is a bearer instrument, so total exposure stays recorded,
   * whatever any counterparty later says it took.
   */
  committedAtomic: z.string().regex(/^\d+$/),
  automaticCommittedAtomic: z.string().regex(/^\d+$/).optional(),
  /**
   * SETTLED: what counterparties reported actually taking, which the router's
   * waived outcomes made a different number from the line above (2026-09-23
   * lookup contract). Optional so a ledger an older build wrote still parses;
   * absent means "everything committed was settled", which is what that build
   * assumed. Reporting only, never a budget input: under-counting exposure
   * because a server said "no charge" is exactly the hole this avoids.
   */
  settledAtomic: z.string().regex(/^\d+$/).optional(),
  reservations: z.array(ReservationSchema),
  /** Unreconciled executor exposure never expires with the daily window. */
  durable: z.array(DurableSpendSchema).max(4096).optional(),
  /** Optional so a ledger an older build wrote still parses; such a ledger
   *  simply has nothing a reconcile can release. */
  exposures: z.array(ExposureSchema).optional(),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export function emptyLedger(nowMs: number): Ledger {
  return {
    schemaVersion: 2,
    windowStartMs: nowMs,
    committedAtomic: '0',
    automaticCommittedAtomic: '0',
    settledAtomic: '0',
    reservations: [],
  };
}

/** Automatic exposure plus automatic pending reservations: the budget's input.
 * Legacy records with no mode/counter conservatively count as automatic. A
 * settled durable record was added to the window counters when it settled, so
 * it is not counted twice here; unresolved records charge every window. */
export function spentOf(ledger: {
  committedAtomic: string;
  automaticCommittedAtomic?: string;
  reservations: { amountAtomic: string; mode?: 'automatic' | 'manual' }[];
  durable?: { amountAtomic: string; state?: 'reserved' | 'signed' | 'settled' }[];
}): bigint {
  return ledger.reservations.reduce(
    (sum, r) => sum + (r.mode === 'manual' ? 0n : BigInt(r.amountAtomic)),
    (ledger.durable ?? []).reduce(
      (sum, entry) => sum + (entry.state === 'settled' ? 0n : BigInt(entry.amountAtomic)),
      BigInt(ledger.automaticCommittedAtomic ?? ledger.committedAtomic),
    ),
  );
}

/**
 * Fold settled records older than the window into one record per run. Their
 * money already reached the window counters when they settled, and their keys
 * can no longer collide with an in-flight request, so only the per-run total and
 * count are worth keeping. Unresolved records are never touched.
 */
export function compactDurable(
  durable: DurableSpend[],
  nowMs: number,
  windowMs: number,
): DurableSpend[] {
  const kept: DurableSpend[] = [];
  const folded = new Map<string, DurableSpend>();
  for (const entry of durable) {
    if (entry.state !== 'settled' || nowMs - entry.atMs < windowMs) {
      kept.push(entry);
      continue;
    }
    const existing = folded.get(entry.runId);
    if (existing === undefined) {
      folded.set(entry.runId, {
        id: `settled:${entry.runId}`,
        requestKey: `settled:${entry.runId}`,
        runId: entry.runId,
        runMaxAtomic: entry.runMaxAtomic,
        amountAtomic: entry.amountAtomic,
        atMs: entry.atMs,
        state: 'settled',
        count: entry.count ?? 1,
      });
      continue;
    }
    existing.amountAtomic = (BigInt(existing.amountAtomic) + BigInt(entry.amountAtomic)).toString();
    existing.atMs = Math.max(existing.atMs, entry.atMs);
    existing.count = (existing.count ?? 1) + (entry.count ?? 1);
  }
  return folded.size === 0 ? durable : [...kept, ...folded.values()];
}

/**
 * ABSENT and CORRUPT both reset the window, but they are not the same fact: the
 * first is a first run, the second is spend that existed and is now gone. Only
 * the second is worth telling anyone about, so the two stay distinguishable here
 * rather than collapsing into one null.
 */
interface LedgerRead {
  ledger: Ledger | null;
  /** Set only when the file EXISTS and could not be turned back into a ledger. */
  corrupt?: string;
}

export async function readLedger(path: string): Promise<LedgerRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // A missing file is the ordinary first run. Any other read failure means a
    // file is there and unusable, which is the corrupt case by another name.
    if (hasCode(err, 'ENOENT')) return { ledger: null };
    return { ledger: null, corrupt: err instanceof Error ? err.message : String(err) };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ledger: null, corrupt: 'not valid JSON' };
  }
  const parsed = LedgerSchema.safeParse(json);
  if (parsed.success) return { ledger: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  const message = issue?.message ?? 'schema mismatch';
  // Field-qualified: "expected number, received undefined" names nothing on its
  // own. zod never echoes the received VALUE, so no spend figure rides along.
  return {
    ledger: null,
    corrupt: field !== undefined && field.length > 0 ? `${field}: ${message}` : message,
  };
}

export interface SpendSummary {
  windowStartMs: number;
  committedAtomic: string;
  automaticCommittedAtomic?: string;
  durable?: DurableSpend[];
  reservations: {
    amountAtomic: string;
    atMs: number;
    requestKey?: string;
    mode?: 'automatic' | 'manual';
  }[];
}

/**
 * The ledger AS AN AUTHORIZATION WOULD SEE IT, for `tenjin status`. Read-only,
 * and it applies the same two expiries the authorizer applies before it
 * evaluates a spend: a rolling window that has run out reads as a fresh one,
 * and reservations past their TTL are gone. Summing the raw file instead
 * reported spend as current, and crashed reservations as open, until the next
 * payment happened to rewrite it.
 *
 * `null` for absent or unreadable, which is the same thing to a report.
 */
export async function readSpendSummary(
  dir: string,
  opts: { now?: () => number; windowMs?: number } = {},
): Promise<SpendSummary | null> {
  const { ledger } = await readLedger(spendLedgerPath(dir));
  if (ledger === null) return null;
  const nowMs = (opts.now ?? Date.now)();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  if (nowMs - ledger.windowStartMs >= windowMs)
    return { ...emptyLedger(nowMs), ...(ledger.durable ? { durable: ledger.durable } : {}) };
  return {
    ...ledger,
    reservations: ledger.reservations.filter((r) => nowMs - r.atMs < RESERVATION_TTL_MS),
  };
}
