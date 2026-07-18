import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic-json';
import { withFileLock } from '../lock';
import {
  evaluateSpendPolicy,
  type PolicyReason,
  type SpendDecision,
  type SpendPolicy,
} from '../policy';
import type { PolicyEnforcement } from './provider';

/**
 * The spend-policy enforcement seam, deliberately in the WALLET PROVIDER layer,
 * BEFORE any signing/payment path, so a future hosted provider (Privy, B5)
 * inherits it: policy moves provider-side by swapping this local authorizer for
 * one the hosted signer enforces. The local authorizer is `client-only` (any
 * process that runs the CLI can edit config or the ledger), and it says so.
 *
 * sessionBudget is enforced ATOMICALLY across the per-command CLI processes an
 * agent spawns: `authorize` takes the file lock and, when a spend may proceed,
 * writes a pending RESERVATION that counts against the budget immediately. Two
 * concurrent authorizations therefore each see the other's reservation and the
 * second is denied, closing the check-then-pay TOCTOU. `commit` finalizes a
 * reservation into committed spend after settlement; `release` drops an unused
 * one (a decline or a failed payment). A reservation left dangling (a crash
 * between authorize and commit) self-expires after RESERVATION_TTL_MS.
 */

const DEFAULT_WINDOW_MS = 86_400_000; // 24h rolling day
const RESERVATION_TTL_MS = 600_000; // 10 min: a dangling reservation self-expires

export interface SpendRequest {
  amountAtomic: bigint;
  creator: string;
  /** The caller's `--max-price` cap, if any. */
  maxPriceAtomic?: bigint;
}

export interface SpendAuthorization {
  decision: SpendDecision;
  reason: PolicyReason;
  message: string;
  amountAtomic: bigint;
  sessionSpentAtomic: bigint;
  sessionBudgetAtomic: bigint;
  policyEnforcement: PolicyEnforcement;
  /** The pending reservation to commit (on settlement) or release (on abort).
   *  Present only when the spend may proceed and a budget is in force. */
  reservationId?: string;
}

export interface SpendAuthorizer {
  policyEnforcement: PolicyEnforcement;
  /** Evaluate a spend against policy + the rolling session ledger, atomically
   *  reserving budget when the spend may proceed. */
  authorize(req: SpendRequest): Promise<SpendAuthorization>;
  /** Finalize a reservation into committed spend after settlement. */
  commit(reservationId: string | undefined): Promise<void>;
  /** Drop an unused reservation (a decline, a 409, or a failed payment). */
  release(reservationId: string | undefined): Promise<void>;
}

const ReservationSchema = z.object({
  id: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
});
type Reservation = z.infer<typeof ReservationSchema>;

const LedgerSchema = z.object({
  schemaVersion: z.literal(2),
  windowStartMs: z.number(),
  committedAtomic: z.string().regex(/^\d+$/),
  reservations: z.array(ReservationSchema),
});
type Ledger = z.infer<typeof LedgerSchema>;

function emptyLedger(nowMs: number): Ledger {
  return { schemaVersion: 2, windowStartMs: nowMs, committedAtomic: '0', reservations: [] };
}

export interface LocalSpendAuthorizerDeps {
  dir: string;
  policy: SpendPolicy;
  /** Rolling window length (ms); default 24h. Injectable for tests. */
  windowMs?: number;
  /** Clock seam for deterministic window tests. */
  now?: () => number;
}

export function createLocalSpendAuthorizer(deps: LocalSpendAuthorizerDeps): SpendAuthorizer {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now;
  const path = join(deps.dir, 'session.json');
  const lockPath = `${path}.lock`;

  // Roll the window and drop expired reservations; returns the live ledger.
  const freshen = (ledger: Ledger | null, nowMs: number): Ledger => {
    if (ledger === null || nowMs - ledger.windowStartMs >= windowMs) return emptyLedger(nowMs);
    return {
      ...ledger,
      reservations: ledger.reservations.filter((r) => nowMs - r.atMs < RESERVATION_TTL_MS),
    };
  };

  const spentOf = (ledger: Ledger): bigint =>
    ledger.reservations.reduce(
      (sum, r) => sum + BigInt(r.amountAtomic),
      BigInt(ledger.committedAtomic),
    );

  const persist = async (ledger: Ledger): Promise<void> => {
    await writeFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
  };

  async function withLedger<T>(fn: (ledger: Ledger, nowMs: number) => Promise<T> | T): Promise<T> {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    return withFileLock(lockPath, async () => {
      const nowMs = now();
      const ledger = freshen(await readLedger(path), nowMs);
      return fn(ledger, nowMs);
    });
  }

  return {
    policyEnforcement: 'client-only',
    async authorize(req: SpendRequest): Promise<SpendAuthorization> {
      return withLedger(async (ledger) => {
        const sessionSpentAtomic = spentOf(ledger);
        const evaluation = evaluateSpendPolicy(deps.policy, {
          amountAtomic: req.amountAtomic,
          creator: req.creator,
          ...(req.maxPriceAtomic !== undefined ? { maxPriceAtomic: req.maxPriceAtomic } : {}),
          sessionSpentAtomic,
        });
        const base: SpendAuthorization = {
          ...evaluation,
          amountAtomic: req.amountAtomic,
          sessionSpentAtomic,
          sessionBudgetAtomic: deps.policy.sessionBudgetAtomic,
          policyEnforcement: 'client-only',
        };
        // Reserve budget atomically only when a spend may proceed AND a ceiling is
        // in force; a denied spend or a disabled budget needs no reservation.
        if (evaluation.decision === 'deny' || deps.policy.sessionBudgetAtomic === 0n) {
          return base;
        }
        const reservation: Reservation = {
          id: randomUUID(),
          amountAtomic: req.amountAtomic.toString(),
          atMs: now(),
        };
        await persist({ ...ledger, reservations: [...ledger.reservations, reservation] });
        return { ...base, reservationId: reservation.id };
      });
    },
    async commit(reservationId: string | undefined): Promise<void> {
      if (reservationId === undefined) return;
      await withLedger(async (ledger) => {
        const reservation = ledger.reservations.find((r) => r.id === reservationId);
        if (reservation === undefined) return; // already released or expired
        await persist({
          ...ledger,
          committedAtomic: (
            BigInt(ledger.committedAtomic) + BigInt(reservation.amountAtomic)
          ).toString(),
          reservations: ledger.reservations.filter((r) => r.id !== reservationId),
        });
      });
    },
    async release(reservationId: string | undefined): Promise<void> {
      if (reservationId === undefined) return;
      await withLedger(async (ledger) => {
        if (!ledger.reservations.some((r) => r.id === reservationId)) return;
        await persist({
          ...ledger,
          reservations: ledger.reservations.filter((r) => r.id !== reservationId),
        });
      });
    },
  };
}

async function readLedger(path: string): Promise<Ledger | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = LedgerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
