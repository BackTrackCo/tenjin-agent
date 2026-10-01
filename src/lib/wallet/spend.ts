import { mkdir, open, rename, rm, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic, writeFileAtomicExclusive } from '../atomic-json';
import { CliError } from '../errors';
import { withFileLock } from '../lock';
import { spendLedgerPath } from '../paths';
import {
  compactDurable,
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
  type PaymentMode,
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
  mode?: PaymentMode;
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
  /** Internal executor scope. Ordinary CLI arguments cannot supply this. */
  durableRun?: { id: string; maxAtomic: bigint };
}

export interface SpendAuthorization {
  decision: SpendDecision;
  reason: PolicyReason;
  message: string;
  amountAtomic: bigint;
  sessionSpentAtomic: bigint;
  sessionBudgetAtomic: bigint | null;
  policyEnforcement: PolicyEnforcement;
  /** The pending reservation to commit (on settlement) or release (on abort).
   *  Present when the spend may proceed, including an unlimited budget. */
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
    opts?: { settledAtomic?: bigint; mode?: PaymentMode; nonce?: string },
  ): Promise<void>;
  /** Drop an unused reservation (a decline, a 409, or a failed payment). */
  release(reservationId: string | undefined): Promise<void>;
  /** Persist uncertainty before the signed authorization can leave this process. */
  markSigned?(reservationId: string): Promise<void>;
  /**
   * A validated provider response arrived for a signed durable reservation: the
   * money joins the current window like an ordinary payment and stops charging
   * later windows. Not chain confirmation; the provider's answer is the evidence.
   */
  settleDurable?(reservationId: string): Promise<void>;
  durableSummary?(runId: string): Promise<DurableSpendSummary>;
}

export interface DurableSpendSummary {
  /** Everything signed for the run: settled plus unresolved. */
  exposureAtomic: string;
  /** Independently reconciled on chain. Always zero in this pilot. */
  confirmedAtomic: string;
  /** Signed with no validated provider response: charged across every window. */
  unknownAtomic: string;
  /** Signed and answered with a valid evaluation: counted in its day's window. */
  settledAtomic: string;
  reservedAtomic: string;
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
  const durableMarker = `${path}.durable`;
  // One notice per authorizer: authorize and commit each read the file, and the
  // reset is not persisted until something is written, so an unlatched warning
  // would fire twice for the same broken file within one command.
  let warnedCorrupt = false;

  // Roll the window and drop expired reservations; returns the live ledger.
  const freshen = (ledger: Ledger | null, nowMs: number): Ledger => {
    if (ledger === null) return emptyLedger(nowMs);
    const durable = ledger.durable ? compactDurable(ledger.durable, nowMs, windowMs) : undefined;
    if (nowMs - ledger.windowStartMs >= windowMs)
      return { ...emptyLedger(nowMs), ...(durable ? { durable } : {}) };
    return {
      ...ledger,
      ...(durable ? { durable } : {}),
      reservations: ledger.reservations.filter((r) => nowMs - r.atMs < RESERVATION_TTL_MS),
    };
  };

  const persist = async (ledger: Ledger): Promise<void> => {
    // The budget record must reach disk before signing. Rename alone is not durable.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  };

  async function withLedger<T>(
    fn: (ledger: Ledger, nowMs: number) => Promise<T> | T,
    strict = false,
  ): Promise<T> {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    return withFileLock(lockPath, async () => {
      const nowMs = now();
      const read = await readLedger(path);
      const durableUsed = await access(durableMarker).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (
        (strict && read.corrupt !== undefined) ||
        (durableUsed && (read.ledger === null || read.ledger.durable === undefined))
      )
        throw new CliError(
          'REFUSED',
          'Durable payment accounting needs recovery; no new payment was authorized.',
        );
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
        const durable = ledger.durable ?? [];
        if (
          req.durableRun &&
          (!req.requestKey || req.durableRun.maxAtomic <= 0n || req.amountAtomic < 0n)
        )
          throw new CliError('REFUSED', 'Invalid durable payment scope.');
        if (
          req.requestKey !== undefined &&
          (ledger.reservations.some((r) => r.requestKey === req.requestKey) ||
            durable.some((r) => r.requestKey === req.requestKey))
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
        if (req.durableRun) {
          const sameRun = durable.filter((entry) => entry.runId === req.durableRun!.id);
          if (sameRun.some((entry) => entry.runMaxAtomic !== req.durableRun!.maxAtomic.toString()))
            throw new CliError('REFUSED', 'A run cannot change its payment ceiling.');
          if (
            durable.length >= 4096 ||
            sameRun.reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n) +
              req.amountAtomic >
              req.durableRun.maxAtomic
          )
            throw new CliError(
              'POLICY_REFUSED',
              'The durable run budget or journal capacity is exhausted.',
            );
        }
        const evaluation = evaluateSpendPolicy(deps.policy, {
          mode: req.mode ?? 'automatic',
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
        // Unlimited budgets still reserve to prevent identical in-flight requests.
        if (evaluation.decision === 'deny') {
          return base;
        }
        const reservation: Reservation = {
          id: randomUUID(),
          mode: req.mode ?? 'automatic',
          amountAtomic: req.amountAtomic.toString(),
          atMs: now(),
          ...(req.requestKey !== undefined ? { requestKey: req.requestKey } : {}),
        };
        if (req.durableRun) {
          // Once used, corruption must not silently reset this wallet's exposure.
          try {
            await writeFileAtomicExclusive(durableMarker, '1\n', { mode: 0o600, dirMode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          await persist({
            ...ledger,
            durable: [
              ...durable,
              {
                id: reservation.id,
                requestKey: req.requestKey!,
                runId: req.durableRun.id,
                runMaxAtomic: req.durableRun.maxAtomic.toString(),
                amountAtomic: reservation.amountAtomic,
                atMs: reservation.atMs,
                state: 'reserved',
              },
            ],
          });
        } else await persist({ ...ledger, reservations: [...ledger.reservations, reservation] });
        return { ...base, reservationId: reservation.id };
      }, req.durableRun !== undefined);
    },
    async commit(
      reservationId: string | undefined,
      amountAtomic: bigint,
      opts: { settledAtomic?: bigint; mode?: PaymentMode; nonce?: string } = {},
    ): Promise<void> {
      // Record transmitted exposure even if its reservation has expired.
      await withLedger(async (ledger) => {
        const durable = ledger.durable?.find((entry) => entry.id === reservationId);
        if (durable) {
          if (durable.amountAtomic !== amountAtomic.toString())
            throw new CliError('REFUSED', 'Durable payment amount changed.');
          // Keep unresolved exposure in its original record. Repeated commits are harmless.
          if (durable.state !== 'signed')
            await persist({
              ...ledger,
              durable: ledger.durable!.map((entry) =>
                entry.id === reservationId ? { ...entry, state: 'signed' as const } : entry,
              ),
            });
          return;
        }
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
        const mode = reservation ? (reservation.mode ?? 'automatic') : (opts.mode ?? 'automatic');
        await persist({
          ...ledger,
          committedAtomic: (BigInt(ledger.committedAtomic) + exposure).toString(),
          automaticCommittedAtomic: (
            BigInt(ledger.automaticCommittedAtomic ?? ledger.committedAtomic) +
            (mode === 'manual' ? 0n : exposure)
          ).toString(),
          settledAtomic: (settledSoFar + settled).toString(),
          reservations:
            reservationId !== undefined
              ? ledger.reservations.filter((r) => r.id !== reservationId)
              : ledger.reservations,
          // Keyed by the authorization's nonce, so a reconcile that proves it
          // was never charged can release this amount and nothing else.
          ...(opts.nonce !== undefined
            ? {
                exposures: [
                  ...(ledger.exposures ?? []),
                  {
                    nonce: opts.nonce.toLowerCase(),
                    amountAtomic: exposure.toString(),
                    atMs: now(),
                    mode,
                  },
                ],
              }
            : {}),
        });
      });
    },
    async release(reservationId: string | undefined): Promise<void> {
      if (reservationId === undefined) return;
      await withLedger(async (ledger) => {
        const durable = ledger.durable?.find((entry) => entry.id === reservationId);
        if (durable) {
          if (durable.state === 'signed') return;
          await persist({
            ...ledger,
            durable: ledger.durable!.filter((entry) => entry.id !== reservationId),
          });
          return;
        }
        if (!ledger.reservations.some((r) => r.id === reservationId)) return;
        await persist({
          ...ledger,
          reservations: ledger.reservations.filter((r) => r.id !== reservationId),
        });
      });
    },
    async markSigned(reservationId) {
      await withLedger(async (ledger) => {
        const entry = ledger.durable?.find((item) => item.id === reservationId);
        if (!entry) throw new CliError('REFUSED', 'Durable payment reservation is unavailable.');
        if (entry.state === 'signed') return;
        await persist({
          ...ledger,
          durable: ledger.durable!.map((item) =>
            item.id === reservationId ? { ...item, state: 'signed' as const } : item,
          ),
        });
      }, true);
    },
    async settleDurable(reservationId) {
      await withLedger(async (ledger) => {
        const entry = ledger.durable?.find((item) => item.id === reservationId);
        if (!entry) throw new CliError('REFUSED', 'Durable payment reservation is unavailable.');
        if (entry.state === 'settled') return;
        if (entry.state !== 'signed')
          throw new CliError('REFUSED', 'Only a signed durable payment can settle.');
        const amount = BigInt(entry.amountAtomic);
        await persist({
          ...ledger,
          committedAtomic: (BigInt(ledger.committedAtomic) + amount).toString(),
          automaticCommittedAtomic: (
            BigInt(ledger.automaticCommittedAtomic ?? ledger.committedAtomic) + amount
          ).toString(),
          settledAtomic: (
            BigInt(ledger.settledAtomic ?? ledger.committedAtomic) + amount
          ).toString(),
          durable: ledger.durable!.map((item) =>
            item.id === reservationId ? { ...item, state: 'settled' as const } : item,
          ),
        });
      }, true);
    },
    async durableSummary(runId) {
      return withLedger((ledger) => {
        const entries = (ledger.durable ?? []).filter((entry) => entry.runId === runId);
        const total = (state: 'signed' | 'settled') =>
          entries
            .filter((entry) => entry.state === state)
            .reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
        const signed = total('signed');
        const settled = total('settled');
        return {
          exposureAtomic: (signed + settled).toString(),
          confirmedAtomic: '0',
          unknownAtomic: signed.toString(),
          settledAtomic: settled.toString(),
          reservedAtomic: entries
            .filter((entry) => entry.state === 'reserved')
            .reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n)
            .toString(),
        };
      }, true);
    },
  };
}

/**
 * GIVE BACK A PAYMENT THE CHAIN PROVED WAS NEVER CHARGED: its authorization
 * expired unused. Exactly the exposure recorded under that nonce comes off the
 * committed totals, once; a nonce from an earlier window, from a ledger an
 * older build wrote, or one already released finds nothing and changes
 * nothing. Returns the amount released, or null when the ledger could not be
 * updated, so the caller keeps the payment open and asks again.
 */
export async function releaseUnchargedExposure(
  dir: string,
  nonce: string,
  opts: { now?: () => number; windowMs?: number } = {},
): Promise<bigint | null> {
  const path = spendLedgerPath(dir);
  const nowMs = (opts.now ?? Date.now)();
  try {
    return await withFileLock(`${path}.lock`, async () => {
      const { ledger } = await readLedger(path);
      if (ledger === null || nowMs - ledger.windowStartMs >= (opts.windowMs ?? DEFAULT_WINDOW_MS)) {
        return 0n;
      }
      const key = nonce.toLowerCase();
      const entry = (ledger.exposures ?? []).find((e) => e.nonce === key);
      if (entry === undefined) return 0n;
      const amount = BigInt(entry.amountAtomic);
      const less = (value: string | undefined, fallback: string): string => {
        const current = BigInt(value ?? fallback);
        return (current > amount ? current - amount : 0n).toString();
      };
      await writeFileAtomic(
        path,
        `${JSON.stringify(
          {
            ...ledger,
            committedAtomic: less(ledger.committedAtomic, '0'),
            ...(entry.mode === 'manual'
              ? {}
              : {
                  automaticCommittedAtomic: less(
                    ledger.automaticCommittedAtomic,
                    ledger.committedAtomic,
                  ),
                }),
            settledAtomic: less(ledger.settledAtomic, ledger.committedAtomic),
            exposures: (ledger.exposures ?? []).filter((e) => e.nonce !== key),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600, dirMode: 0o700 },
      );
      return amount;
    });
  } catch {
    return null;
  }
}

export { readSpendSummary, type SpendSummary } from '../spend-ledger';
