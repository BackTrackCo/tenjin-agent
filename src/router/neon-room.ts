import type { CommandContext } from '../context';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';

/**
 * THE ONE RULE FOR WHAT A NEON CALL MAY SPEND, called by the handoff before a worker starts and by
 * the transport before a request is sent, so the two can never disagree about what a call needs
 * and what is granted.
 *
 *   need = the real request's size at the row's price, plus one floor-sized turn of output
 *          (the handoff has only an estimate before the worker exists; the transport has the
 *          request itself and keeps what it measured).
 *   room = the least of
 *          - what one channel may hold,
 *          - what is left of the job's budget (its ceiling and what was granted, less what it spent),
 *          - the larger of (the person's per-call limit or the day's remaining budget, whichever is
 *            less) and the UNUSED APPROVAL of this job.
 *
 * A call with need above room is asked about: the quote is the shortfall measured against every one
 * of those, nothing is sent and no worker starts. The tool payer's rule applies to the yes: it
 * lifts the per-call limit and the day's budget for ONE payment, as an approved payment, the
 * allowlist still holds, and the approval is spent by that payment's whole voucher ceiling. What
 * the seller then charges less than that ceiling is dropped, not returned: the next call asks
 * again for what it needs. The day's budget counts every automatic charge and pending reservation.
 */
export type NeonLimits = {
  /** The person's per-call limit. */
  perCallAtomic: bigint;
  /** What the rolling day's budget has left, or null with no budget. */
  dayLeftAtomic: bigint | null;
  /** What one payment channel may hold. */
  depositCapAtomic: bigint;
};

/** What one job has left: its budget, and the part of what was approved that nothing used. */
export type NeonJobRoom = { jobLeftAtomic: bigint; approvedLeftAtomic: bigint };

export async function neonLimits(
  ctx: Pick<CommandContext, 'dataDir'> & { flags?: Partial<CommandContext['flags']> },
  depositCapAtomic: bigint,
  now?: () => number,
): Promise<NeonLimits> {
  const { policy } = await resolveContextSettings({
    dataDir: ctx.dataDir,
    flags: ctx.flags ?? {},
  } as CommandContext);
  const ledger = await readSpendSummary(ctx.dataDir, { ...(now ? { now } : {}) });
  const spent = ledger === null ? 0n : spentOf(ledger);
  const budget = policy.sessionBudgetAtomic;
  return {
    perCallAtomic: policy.maxAutoSpendAtomic,
    dayLeftAtomic: budget === null ? null : budget > spent ? budget - spent : 0n,
    depositCapAtomic,
  };
}

/** The most one call may spend without asking: the per-call limit, or less where the day has less. */
export const neonNormalRoom = (limits: NeonLimits): bigint =>
  limits.dayLeftAtomic !== null && limits.dayLeftAtomic < limits.perCallAtomic
    ? limits.dayLeftAtomic
    : limits.perCallAtomic;

/** The room of one call, and whether it needs the job's approval to use it. */
export function neonRoom(
  limits: NeonLimits,
  job: NeonJobRoom,
): { room: bigint; approved: boolean } {
  const normal = neonNormalRoom(limits);
  const lifted = job.approvedLeftAtomic > normal ? job.approvedLeftAtomic : normal;
  let room = lifted;
  if (job.jobLeftAtomic < room) room = job.jobLeftAtomic;
  if (limits.depositCapAtomic < room) room = limits.depositCapAtomic;
  return { room, approved: room > normal };
}

export type NeonShortfall =
  /** Nothing is missing. */
  | null
  /** No grant could carry it: more than one channel holds. */
  | { impossible: true }
  /** What to grant, and in which words it was missing. */
  | { grantAtomic: bigint; why: string };

const usd = (atomic: bigint) => `$${toMoney(atomic.toString()).usd}`;

/**
 * What is missing for a call of `need`, as ONE grant that fills the job's own budget and the
 * unused approval together (a grant adds to both), so that the call fits after the yes.
 */
export function neonShortfall(need: bigint, limits: NeonLimits, job: NeonJobRoom): NeonShortfall {
  if (need <= neonRoom(limits, job).room) return null;
  if (need > limits.depositCapAtomic) return { impossible: true };
  const normal = neonNormalRoom(limits);
  const forJob = need > job.jobLeftAtomic ? need - job.jobLeftAtomic : 0n;
  const forApproval =
    need > normal && need > job.approvedLeftAtomic ? need - job.approvedLeftAtomic : 0n;
  const grantAtomic = forJob > forApproval ? forJob : forApproval;
  const reasons: string[] = [];
  if (forJob > 0n)
    reasons.push(`more than the ${usd(job.jobLeftAtomic)} left in the job's ceiling`);
  if (need > limits.perCallAtomic)
    reasons.push(
      `more than the ${usd(limits.perCallAtomic)} this machine pays for one call without asking`,
    );
  else if (limits.dayLeftAtomic !== null && need > limits.dayLeftAtomic)
    reasons.push(`more than today's automatic budget has left (${usd(limits.dayLeftAtomic)})`);
  return { grantAtomic, why: reasons.join(' and ') };
}
