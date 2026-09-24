import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../atomic-json';
import { withFileLock } from '../lock';
import { spendLedgerPath } from '../paths';
import {
  DEFAULT_WINDOW_MS,
  emptyLedger,
  readLedger,
  RESERVATION_TTL_MS,
  spentOf,
  type Ledger,
  type Reservation,
} from '../spend-ledger';
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

export interface SpendRequest {
  amountAtomic: bigint;
  creator: string;
  /** The caller's `--max-price` cap, if any. */
  maxPriceAtomic?: bigint;
  /**
   * THE SAME-TURN DUPLICATE GUARD. An opaque identity for the request being
   * paid for (its destination and its exact arguments), recorded on the
   * reservation. A second authorization carrying a key an unexpired reservation
   * already holds is DENIED rather than reserved, so one in-flight payment can
   * never become two because a caller retried, a harness re-fired, or a second
   * process asked for the same thing. Same lock and same file as the budget, so
   * the check is atomic across the per-command processes an agent spawns; the
   * reservation TTL is what bounds "same turn". Omit it and nothing changes.
   */
  requestKey?: string;
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
  /**
   * Finalize a reservation into committed spend after settlement. Runs only
   * post-settlement, so `amountAtomic` is authoritative: if the reservation
   * TTL-expired mid-confirm (a human can out-wait RESERVATION_TTL_MS at the
   * prompt), the settled amount is still recorded rather than silently lost
   * from the rolling budget.
   */
  commit(
    reservationId: string | undefined,
    amountAtomic: bigint,
    /** What the counterparty reported actually taking, when it said so at all.
     *  Omitted means "assume it took what was authorized", the conservative
     *  reading every caller had before the router began waiving fees. */
    opts?: { settledAtomic?: bigint },
  ): Promise<void>;
  /** Drop an unused reservation (a decline, a 409, or a failed payment). */
  release(reservationId: string | undefined): Promise<void>;
}

export interface LocalSpendAuthorizerDeps {
  dir: string;
  policy: SpendPolicy;
  /** Rolling window length (ms); default 24h. Injectable for tests. */
  windowMs?: number;
  /** Clock seam for deterministic window tests. */
  now?: () => number;
  /**
   * Called at most ONCE per authorizer when the ledger file exists but cannot be
   * read back. The reset below is fail-open by design, and a silent one hands back
   * budget the operator believes is already spent — so the caller gets to say so.
   */
  onCorrupt?: (reason: string) => void;
}

export function createLocalSpendAuthorizer(deps: LocalSpendAuthorizerDeps): SpendAuthorizer {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now;
  const path = spendLedgerPath(deps.dir);
  const lockPath = `${path}.lock`;
  // One notice per authorizer: authorize and commit each read the file, and the
  // reset is not persisted until something is written, so an unlatched warning
  // would fire twice for the same broken file within one command.
  let warnedCorrupt = false;

  // Roll the window and drop expired reservations; returns the live ledger.
  const freshen = (ledger: Ledger | null, nowMs: number): Ledger => {
    if (ledger === null || nowMs - ledger.windowStartMs >= windowMs) return emptyLedger(nowMs);
    return {
      ...ledger,
      reservations: ledger.reservations.filter((r) => nowMs - r.atMs < RESERVATION_TTL_MS),
    };
  };

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
      const read = await readLedger(path);
      if (read.corrupt !== undefined && !warnedCorrupt) {
        warnedCorrupt = true;
        deps.onCorrupt?.(read.corrupt);
      }
      const ledger = freshen(read.ledger, nowMs);
      return fn(ledger, nowMs);
    });
  }

  return {
    policyEnforcement: 'client-only',
    async authorize(req: SpendRequest): Promise<SpendAuthorization> {
      return withLedger(async (ledger) => {
        const sessionSpentAtomic = spentOf(ledger);
        if (
          req.requestKey !== undefined &&
          ledger.reservations.some((r) => r.requestKey === req.requestKey)
        ) {
          return {
            decision: 'deny',
            reason: 'duplicate_in_flight',
            message:
              'An identical request already holds a reservation in this turn. No second payment was made.',
            amountAtomic: req.amountAtomic,
            sessionSpentAtomic,
            sessionBudgetAtomic: deps.policy.sessionBudgetAtomic,
            policyEnforcement: 'client-only',
          };
        }
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
          ...(req.requestKey !== undefined ? { requestKey: req.requestKey } : {}),
        };
        await persist({ ...ledger, reservations: [...ledger.reservations, reservation] });
        return { ...base, reservationId: reservation.id };
      });
    },
    async commit(
      reservationId: string | undefined,
      amountAtomic: bigint,
      opts: { settledAtomic?: bigint } = {},
    ): Promise<void> {
      // No reservation id means no budget ceiling was in force at authorize
      // time; the settled spend still counts against any FUTURE budget window.
      await withLedger(async (ledger) => {
        const reservation =
          reservationId !== undefined
            ? ledger.reservations.find((r) => r.id === reservationId)
            : undefined;
        const exposure =
          reservation !== undefined ? BigInt(reservation.amountAtomic) : amountAtomic;
        // TWO NUMBERS, ON PURPOSE. The budget keeps counting what left; the
        // settled total records what was taken, and they differ whenever a
        // counterparty waives a fee against an authorization already sent.
        const settled = opts.settledAtomic ?? exposure;
        const settledSoFar = BigInt(ledger.settledAtomic ?? ledger.committedAtomic);
        await persist({
          ...ledger,
          committedAtomic: (BigInt(ledger.committedAtomic) + exposure).toString(),
          settledAtomic: (settledSoFar + settled).toString(),
          reservations:
            reservationId !== undefined
              ? ledger.reservations.filter((r) => r.id !== reservationId)
              : ledger.reservations,
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

export { readSpendSummary, type SpendSummary } from '../spend-ledger';
