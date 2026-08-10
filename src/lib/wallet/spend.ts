import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic-json';
import { hasCode } from '../errno';
import { withFileLock } from '../lock';
import { spendLedgerPath } from '../paths';
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
  /**
   * Finalize a reservation into committed spend after settlement. Runs only
   * post-settlement, so `amountAtomic` is authoritative: if the reservation
   * TTL-expired mid-confirm (a human can out-wait RESERVATION_TTL_MS at the
   * prompt), the settled amount is still recorded rather than silently lost
   * from the rolling budget.
   */
  commit(reservationId: string | undefined, amountAtomic: bigint): Promise<void>;
  /** Drop an unused reservation (a decline, a 409, or a failed payment). */
  release(reservationId: string | undefined): Promise<void>;
}

const ReservationSchema = z.object({
  id: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
});
type Reservation = z.infer<typeof ReservationSchema>;

const SpendEventSchema = z.object({
  amountAtomic: z.string().regex(/^\d+$/),
  atMs: z.number(),
});
type SpendEvent = z.infer<typeof SpendEventSchema>;

const LedgerV2Schema = z.object({
  schemaVersion: z.literal(2),
  windowStartMs: z.number(),
  committedAtomic: z.string().regex(/^\d+$/),
  reservations: z.array(ReservationSchema),
});
const LedgerSchema = z.object({
  schemaVersion: z.literal(3),
  windowStartMs: z.number(),
  committedAtomic: z.string().regex(/^\d+$/),
  history: z.array(SpendEventSchema),
  reservations: z.array(ReservationSchema),
});
type Ledger = z.infer<typeof LedgerSchema>;

function emptyLedger(nowMs: number): Ledger {
  return {
    schemaVersion: 3,
    windowStartMs: nowMs,
    committedAtomic: '0',
    history: [],
    reservations: [],
  };
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
      history: ledger.history.filter((event) => nowMs - event.atMs < DEFAULT_WINDOW_MS),
      reservations: ledger.reservations.filter((r) => nowMs - r.atMs < RESERVATION_TTL_MS),
    };
  };

  const spentOf = (ledger: Ledger): bigint =>
    ledger.reservations.reduce(
      (sum, r) => sum + BigInt(r.amountAtomic),
      BigInt(ledger.committedAtomic),
    );

  const spentSince = (ledger: Ledger, nowMs: number, periodMs: number): bigint => {
    const cutoff = nowMs - periodMs;
    const committed = ledger.history
      .filter((event) => event.atMs > cutoff)
      .reduce((sum, event) => sum + BigInt(event.amountAtomic), 0n);
    return ledger.reservations
      .filter((reservation) => reservation.atMs > cutoff)
      .reduce((sum, reservation) => sum + BigInt(reservation.amountAtomic), committed);
  };

  const hasHardBudget = (): boolean =>
    deps.policy.sessionBudgetAtomic > 0n ||
    deps.policy.hourlyBudgetAtomic !== undefined ||
    deps.policy.dailyBudgetAtomic !== undefined;

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
      return withLedger(async (ledger, nowMs) => {
        const sessionSpentAtomic = spentOf(ledger);
        const evaluation = evaluateSpendPolicy(deps.policy, {
          amountAtomic: req.amountAtomic,
          creator: req.creator,
          ...(req.maxPriceAtomic !== undefined ? { maxPriceAtomic: req.maxPriceAtomic } : {}),
          sessionSpentAtomic,
          hourlySpentAtomic: spentSince(ledger, nowMs, 3_600_000),
          dailySpentAtomic: spentSince(ledger, nowMs, DEFAULT_WINDOW_MS),
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
        if (evaluation.decision === 'deny' || !hasHardBudget()) {
          return base;
        }
        const reservation: Reservation = {
          id: randomUUID(),
          amountAtomic: req.amountAtomic.toString(),
          atMs: nowMs,
        };
        await persist({ ...ledger, reservations: [...ledger.reservations, reservation] });
        return { ...base, reservationId: reservation.id };
      });
    },
    async commit(reservationId: string | undefined, amountAtomic: bigint): Promise<void> {
      // No reservation id means no budget ceiling was in force at authorize
      // time; the settled spend still counts against any FUTURE budget window.
      await withLedger(async (ledger, nowMs) => {
        const reservation =
          reservationId !== undefined
            ? ledger.reservations.find((r) => r.id === reservationId)
            : undefined;
        const settled = reservation !== undefined ? BigInt(reservation.amountAtomic) : amountAtomic;
        await persist({
          ...ledger,
          committedAtomic: (BigInt(ledger.committedAtomic) + settled).toString(),
          history: [...ledger.history, { amountAtomic: settled.toString(), atMs: nowMs }],
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

async function readLedger(path: string): Promise<LedgerRead> {
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
  const legacy = LedgerV2Schema.safeParse(json);
  if (legacy.success) {
    const v2 = legacy.data;
    const history: SpendEvent[] =
      BigInt(v2.committedAtomic) > 0n
        ? [{ amountAtomic: v2.committedAtomic, atMs: v2.windowStartMs }]
        : [];
    return { ledger: { ...v2, schemaVersion: 3, history } };
  }
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
