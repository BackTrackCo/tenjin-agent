import { toMoney } from '../lib/money';
import { createQuote, quoteClosed, readQuote, useQuote, type Quote } from '../lib/spend-quotes';
import type { ModelJob } from './model-job';
import { approveCall } from './plan';
import { grantNeonRoom } from './neon-transport';
import { neonHost, type NeonTerms } from './neon-terms';

/**
 * A REVISION PAST THE JOB CEILING IS ASKED ABOUT, NOT REFUSED. A Neon job shares one ceiling
 * between its first draft and its revisions. When a revision would have no room left for another
 * call, nothing is sent: the door keeps a quote for one more ceiling, and the answer names the
 * `approve` call. `approve` is never pre-allowed, so the host's own prompt shows the person the
 * total and what it buys, and only their yes runs it. The run puts the extra ceiling on the SAME
 * job, so its worker, its history and its record stay, and the revision is sent again to the
 * same `worker_handle`. The quote runs once.
 */
const KIND = 'neon_revision';

type NeonRevisionCall = { kind: typeof KIND; jobId: string; handle: string; ceilingAtomic: string };

const isRevisionCall = (call: unknown): call is NeonRevisionCall =>
  typeof call === 'object' &&
  call !== null &&
  (call as { kind?: unknown }).kind === KIND &&
  typeof (call as { jobId?: unknown }).jobId === 'string' &&
  /^\d+$/.test(String((call as { ceilingAtomic?: unknown }).ceilingAtomic));

/** Whether a quote is a Neon revision's, which only this module runs. */
export const isNeonRevisionQuote = (quote: Quote): boolean => isRevisionCall(quote.call);

const usd = (atomic: bigint) => `$${toMoney(atomic.toString()).usd}`;

/** The quote for one more ceiling on a job, and the answer a parent is handed for it. */
export async function neonRevisionApproval(
  dataDir: string,
  original: Pick<ModelJob, 'id'>,
  handle: string,
  terms: NeonTerms,
  ceilingAtomic: bigint,
  leftAtomic: bigint,
) {
  const what = `one more ceiling of ${usd(ceilingAtomic)} for revisions of the ${terms.label} writing job`;
  const quote = await createQuote(dataDir, {
    what,
    sentence: `This revision has no room left in its job ceiling (${usd(leftAtomic)} left), so another ceiling of ${usd(ceilingAtomic)} would be paid to ${neonHost(terms)} as the writer's calls need it.`,
    payments: [{ amountAtomic: ceilingAtomic, creator: neonHost(terms) }],
    call: { kind: KIND, jobId: original.id, handle, ceilingAtomic: ceilingAtomic.toString() },
  });
  return {
    status: 'needs_approval' as const,
    action: 'refused' as const,
    started: false,
    reason: `needs_approval: ${quote.sentence} Nothing was sent and nothing was paid.`,
    instruction: `Call ${approveCall(quote)}: it asks the user and runs only on their yes. On the yes, send the same revision again to the same worker handle; its history stays. Do not start a new worker for it.`,
    quote: {
      id: quote.id,
      what: quote.what,
      total: usd(ceilingAtomic),
      expiresAt: quote.expiresAt,
    },
  };
}

/** What `approve` returns for a Neon revision: the same shape the tool's other answers use. */
export type NeonApproveResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The yes: checked against what the person was shown (the quote's own total and words), used up
 * once, then the job's ceiling grows by the quoted amount. Nothing is paid here: the revision's
 * own calls pay, one voucher each, inside the person's daily budget as always.
 */
export async function runNeonApprove(
  args: { quote: string; total?: string; what?: string },
  deps: { dataDir: string; now?: () => number },
): Promise<NeonApproveResult | null> {
  const now = deps.now ?? Date.now;
  const quote = await readQuote(deps.dataDir, args.quote.trim());
  if (quote === null || !isRevisionCall(quote.call)) return null;
  const closed = quoteClosed(quote, now());
  if (closed !== null)
    return {
      ok: false,
      reason:
        closed === 'used'
          ? 'That quote already ran, and a quote runs once, so nothing more was granted.'
          : 'That quote expired (a quote waits ten minutes for a yes), so nothing was granted. Send the revision again for a fresh one.',
    };
  if (
    args.total === undefined ||
    args.what === undefined ||
    args.what.trim() !== quote.what ||
    args.total.trim().replace(/^\$/, '') !== usd(BigInt(quote.totalAtomic)).replace(/^\$/, '')
  )
    return {
      ok: false,
      reason: `Send the quote's own total and words, so the user is shown what they approve: ${usd(BigInt(quote.totalAtomic))}, ${quote.what}. Nothing was granted.`,
    };
  const used = await useQuote(deps.dataDir, quote.id, now);
  if ('refused' in used)
    return { ok: false, reason: 'That quote can no longer run, so nothing was granted.' };
  const call = quote.call as NeonRevisionCall;
  await grantNeonRoom(deps.dataDir, call.jobId, BigInt(call.ceilingAtomic));
  return {
    ok: true,
    text: `Approved: the writing job has ${usd(BigInt(call.ceilingAtomic))} more room. Send the revision again to worker ${call.handle}.`,
  };
}
