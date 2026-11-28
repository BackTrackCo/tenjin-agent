import { toMoney } from '../lib/money';
import { createQuote, quoteClosed, readQuote, useQuote, type Quote } from '../lib/spend-quotes';
import type { ModelJob } from './model-job';
import { approveCall } from './plan';
import { modelSettings } from './model-settings';
import { NEON_CHANNEL_DEPOSIT_CAP_ATOMIC } from './neon-seller';
import { neonLimits, neonShortfall } from './neon-room';
import { grantNeonRoom, markNeonAwaiting, neonJobRoom, readNeonRecord } from './neon-transport';
import { neonHost, neonTermsSchema, type NeonTerms } from './neon-terms';

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

type NeonRevisionCall = {
  kind: typeof KIND;
  jobId: string;
  handle: string;
  ceilingAtomic: string;
  /** What follows the yes: a revision sent again, or the first draft's offer accepted. */
  then?: 'first_call';
};

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
  why?: string,
  after?: string,
) {
  const what = `one more ceiling of ${usd(ceilingAtomic)} for revisions of the ${terms.label} writing job`;
  const quote = await createQuote(dataDir, {
    what,
    sentence: `This revision has no room left (${why ?? `the job ceiling has ${usd(leftAtomic)} left`}), so another ceiling of ${usd(ceilingAtomic)} would be paid to ${neonHost(terms)} as the writer's calls need it.`,
    payments: [{ amountAtomic: ceilingAtomic, creator: neonHost(terms) }],
    call: { kind: KIND, jobId: original.id, handle, ceilingAtomic: ceilingAtomic.toString() },
  });
  return {
    status: 'needs_approval' as const,
    action: 'refused' as const,
    started: false,
    reason: `needs_approval: ${quote.sentence} Nothing was sent and nothing was paid.`,
    instruction: `Call ${approveCall(quote)}: it asks the user and runs only on their yes. ${after ?? 'On the yes, send the same revision again to the same worker handle; its history stays.'} Do not start a new worker for it.`,
    quote: {
      id: quote.id,
      what: quote.what,
      total: usd(ceilingAtomic),
      expiresAt: quote.expiresAt,
    },
  };
}

/**
 * A FIRST DRAFT THE JOB CEILING CANNOT CARRY is asked about before anything is sent, with the
 * same quote and the same `approve`. The job exists with no spend; the yes grows its ceiling, and
 * the first call is then paid as an approved payment, past the per-call limit. Nothing of the
 * draft leaves the machine until then.
 */
export async function neonFirstCallApproval(
  dataDir: string,
  job: Pick<ModelJob, 'id'>,
  handle: string,
  terms: NeonTerms,
  grantAtomic: bigint,
  needAtomic: bigint,
  why: string,
) {
  const what = `a ${terms.label} writing job, up to ${usd(needAtomic)} for its first call`;
  const quote = await createQuote(dataDir, {
    what,
    sentence: `This draft needs up to ${usd(needAtomic)} for its first call, ${why}, so it would be paid to ${neonHost(terms)} as the writer's calls need it.`,
    payments: [{ amountAtomic: needAtomic, creator: neonHost(terms) }],
    call: {
      kind: KIND,
      jobId: job.id,
      handle,
      ceilingAtomic: grantAtomic.toString(),
      then: 'first_call',
    },
  });
  // The queued draft does not run until this quote's yes is recorded.
  await markNeonAwaiting(dataDir, job.id, quote.id);
  return {
    status: 'needs_approval' as const,
    action: 'refused' as const,
    started: false,
    reason: `needs_approval: ${quote.sentence} Nothing was sent and nothing was paid.`,
    instruction: `Call ${approveCall(quote)}: it asks the user and runs only on their yes. On the yes, run the draft by calling subagent({offer_id: ${JSON.stringify(job.id)}}); do not run it before. Do not change a setting for it.`,
    offer_id: job.id,
    quote: { id: quote.id, what: quote.what, total: usd(needAtomic), expiresAt: quote.expiresAt },
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
  await grantNeonRoom(deps.dataDir, call.jobId, BigInt(call.ceilingAtomic), quote.id);
  return {
    ok: true,
    text:
      call.then === 'first_call'
        ? `Approved: the writing job has ${usd(BigInt(call.ceilingAtomic))} more room. Run the draft by calling subagent({offer_id: ${JSON.stringify(call.jobId)}}).`
        : `Approved: the writing job has ${usd(BigInt(call.ceilingAtomic))} more room. Send the revision again to worker ${call.handle}.`,
  };
}

/**
 * A CALL THAT DID NOT FIT WHEN ITS REAL REQUEST WAS MEASURED (a first draft larger than the
 * door's estimate, or a revision that grew): the transport sent nothing and kept what the request
 * needs. The answer is the same quote the handoff gives, for the shortfall against every limit,
 * and the worker stays: the unanswered call did not end its conversation, so the yes and a short
 * message go on with the same history. Null where nothing was measured or nothing is missing.
 */
export async function neonMissApproval(
  dataDir: string,
  job: Pick<ModelJob, 'id' | 'capAtomic' | 'root' | 'decision'>,
  handle: string,
) {
  const terms = neonTermsSchema.safeParse(job.decision.neonTerms);
  if (!terms.success) return null;
  const record = await readNeonRecord(dataDir, job.id);
  if (record?.needAtomic === undefined) return null;
  const settings = await modelSettings(dataDir, job.root, 'neon');
  if (!settings) return null;
  const room = await neonJobRoom(dataDir, job, settings.maxJobAtomic);
  const shortfall = neonShortfall(
    BigInt(record.needAtomic),
    await neonLimits({ dataDir }, NEON_CHANNEL_DEPOSIT_CAP_ATOMIC),
    room,
  );
  if (!shortfall || 'impossible' in shortfall) return null;
  return neonRevisionApproval(
    dataDir,
    job,
    handle,
    terms.data,
    shortfall.grantAtomic,
    room.jobLeftAtomic,
    shortfall.why,
    'On the yes, send the worker a short message (for example "go on") to the same worker handle: its history stays, and the call that did not fit is sent then.',
  );
}
