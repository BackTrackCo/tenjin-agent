import type { ChainRead } from './routing-payer';
import { mkdir, stat } from 'node:fs/promises';
import type { Hex } from 'viem';
import { join } from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import { canonicalHash } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import { admitPlan } from '../lib/spend-plan';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import { modelLock, ModelJobStore, type ModelJob } from './model-job';
import { modelSettings, NEON_ROUTER_ORIGIN } from './model-settings';
import { ModelCallFailed, ModelWorkerStopped } from './model-worker-control';
import { appendPaidRecord, recordedSent } from './paid';
import { readJsonFile, writePrivate } from './store-files';
import {
  BatchSeller,
  channelKey,
  type ChannelConfig,
  type PaymentApproval,
  type SignedDeposit,
  ChannelDepositRefused,
  NEON_CHANNEL_DEPOSIT_CAP_ATOMIC,
  PayeeMismatch,
} from './neon-seller';
import {
  capturedRequest,
  chatBody,
  chatUsage,
  fittingNeonTokens,
  inputSplit,
  messageOf,
  NEON_CALL_TIMEOUT_MS,
  NEON_CAPTURE_ENV,
  NEON_DEFAULT_EFFORT,
  NEON_EFFORTS,
  NEON_TURN_FLOOR_TOKENS,
  NEON_TURN_MAX_TOKENS,
  neonPeakQuoteAtomic,
  NeonNoText,
  NeonReplyInvalid,
  replyOfBody,
  type NeonEffort,
  type NeonUsage,
  type ThoughtCarry,
} from './neon-chat';
import { neonHost, neonTermsSchema, type NeonTerms } from './neon-terms';
import { NeonRefunds } from './neon-refund';
import { neonLimits, neonRoom } from './neon-room';
import type { PinnedFetchOptions } from './pinned-fetch';

/**
 * How long a run's end waits for the channel refund before it delivers the result. A refund that
 * does not finish stays on record as failed, for `tenjin refund`.
 */
export const NEON_CLOSE_MS = 15_000;

/** The task class every Neon job is recorded under: the worker takes writing jobs. */
export const NEON_TASK_CLASS = 'writing';
/** Calls kept in one job's record: a job has no turn limit, its ceiling is the bound. */
const CALLS_KEPT = 2_000;

const callSchema = z.object({
  n: z.number().int().positive(),
  at: z.number(),
  /** The tokens the seller reported for the call; zero where it reported none. */
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  /** Where the input tokens went, shared by bytes: the system part, the tools, the messages. */
  systemTokens: z.number().optional(),
  toolsTokens: z.number().optional(),
  messageTokens: z.number().optional(),
  /** The model that answered the call, as it was asked for. */
  model: z.string().optional(),
  /** Thought tokens counted in the output, where the seller reports them. */
  reasoningTokens: z.number().optional(),
  /** The request body's size in bytes: a revision's history is at least this big again. */
  bytes: z.number().optional(),
  /** The `max_tokens` the call asked for: what the seller's quote was sized by. */
  maxTokens: z.number(),
  /** What the seller quoted and the wallet signed, atomic USDC. */
  quotedAtomic: z.string().regex(/^\d+$/),
  /** What settled: the quote when the chain or the seller's receipt shows it, else null. */
  settledAtomic: z.string().regex(/^\d+$/).nullable(),
  settlement: z.enum(['settled', 'unknown']),
  ok: z.boolean(),
  /** When a call left uncertain can be proven unpaid (ms): its deposit authorization's expiry. */
  resolvesAt: z.number().optional(),
  ms: z.number(),
  txHash: z.string().optional(),
});
export type NeonCall = z.infer<typeof callSchema>;

/**
 * A NEON JOB'S RECORD, kept with the job's other records (`model-jobs/<id>.neon.json`) so a
 * later step can compute the mean settled spend per writing job: the task class, the calls
 * with their tokens, `max_tokens` and quoted and settled amounts, and the job's wall time.
 * It also holds the thought signatures of the job's tool calls, which a continuation needs.
 */
const recordSchema = z.object({
  version: z.literal(1),
  jobId: z.string(),
  taskClass: z.literal(NEON_TASK_CLASS),
  startedAt: z.number(),
  /** Time workers of this job ran, summed over its runs. */
  wallMs: z.number(),
  /** Every amount signed, uncertain ones included: what counts against the job's ceiling. */
  spentAtomic: z.string().regex(/^\d+$/),
  /** Room the person approved beyond the ceiling, one more ceiling at a time (`approve`). */
  grantedAtomic: z.string().regex(/^\d+$/).default('0'),
  /** Approved room already spent on a payment over the per-call limit: an approval is spent once. */
  approvedSpentAtomic: z.string().regex(/^\d+$/).default('0'),
  /** The quote a first draft waits on: until the person's yes is recorded, the job does not run. */
  awaiting: z.string().optional(),
  /** What the last call that did not fit would have needed, measured from its real request. */
  needAtomic: z.string().regex(/^\d+$/).optional(),
  settledAtomic: z.string().regex(/^\d+$/),
  calls: z.array(callSchema),
  signatures: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** The last few reasons a call was not sent, for finding why a job ended without one. */
  notSent: z.array(z.string().max(300)).max(5).default([]),
});
export type NeonRecord = z.infer<typeof recordSchema>;

export const neonRecordPath = (dataDir: string, jobId: string) =>
  join(dataDir, 'model-jobs', `${jobId}.neon.json`);

export const freshNeonRecord = (jobId: string, startedAt: number): NeonRecord => ({
  version: 1,
  jobId,
  taskClass: NEON_TASK_CLASS,
  startedAt,
  wallMs: 0,
  spentAtomic: '0',
  grantedAtomic: '0',
  approvedSpentAtomic: '0',
  settledAtomic: '0',
  calls: [],
  signatures: {},
  notSent: [],
});

export async function readNeonRecord(dataDir: string, jobId: string): Promise<NeonRecord | null> {
  const parsed = recordSchema.safeParse(
    await readJsonFile(neonRecordPath(dataDir, jobId), 4_000_000),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * A job's record, for a write. Absent is null; one that exists and cannot be read is NEVER null,
 * because a fresh record written over it would forget what the job spent and was granted.
 */
async function readNeonRecordForWrite(dataDir: string, jobId: string): Promise<NeonRecord | null> {
  const kept = await readNeonRecord(dataDir, jobId);
  if (kept) return kept;
  const exists = await stat(neonRecordPath(dataDir, jobId)).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
  );
  if (exists)
    throw new CliError(
      'CONFIG_INVALID',
      `The record of Neon job ${jobId} exists but cannot be read. Nothing was changed: it holds what the job spent and was granted, so it is kept as it is.`,
    );
  return null;
}

/** The room a job has left: its ceiling and what the person approved, less what it spent. */
export async function neonRoomLeftAtomic(
  dataDir: string,
  job: Pick<ModelJob, 'id' | 'capAtomic'>,
  maxJobAtomic: bigint,
): Promise<bigint> {
  const record = await readNeonRecord(dataDir, job.id);
  const ceiling = maxJobAtomic < BigInt(job.capAtomic) ? maxJobAtomic : BigInt(job.capAtomic);
  // A job that has made no call has spent nothing: its whole ceiling is left.
  if (!record) return ceiling;
  const left = ceiling + BigInt(record.grantedAtomic) - BigInt(record.spentAtomic);
  return left > 0n ? left : 0n;
}

/** What a job has left of its budget and of what the person approved for it that nothing used. */
export async function neonJobRoom(
  dataDir: string,
  job: Pick<ModelJob, 'id' | 'capAtomic'>,
  maxJobAtomic: bigint,
): Promise<{ jobLeftAtomic: bigint; approvedLeftAtomic: bigint }> {
  const record = await readNeonRecord(dataDir, job.id);
  const jobLeftAtomic = await neonRoomLeftAtomic(dataDir, job, maxJobAtomic);
  const approved = record ? BigInt(record.grantedAtomic) - BigInt(record.approvedSpentAtomic) : 0n;
  return { jobLeftAtomic, approvedLeftAtomic: approved > 0n ? approved : 0n };
}

/**
 * WHAT A DEPOSIT MEETS: the per-call limit, the rolling day's budget and the allowlist, as any
 * payment does. It resolves to nothing where the whole amount is admitted, and to the most the
 * limits admit where it is not, so the deposit can shrink to fit instead of refusing a call that
 * does. A payee the person has not allowed is refused outright.
 */
export function depositAdmitter(options: {
  dataDir: string;
  policy: Parameters<typeof admitPlan>[1]['policy'];
  creator: string;
  now?: () => number;
}): (amountAtomic: bigint) => Promise<bigint | undefined> {
  return async (amountAtomic) => {
    const admission = await admitPlan([{ amountAtomic, creator: options.creator }], {
      dataDir: options.dataDir,
      policy: options.policy,
      ...(options.now ? { now: options.now } : {}),
    });
    if ('admitted' in admission) return undefined;
    if ('refused' in admission)
      throw new CliError('POLICY_REFUSED', admission.refused.message, {
        details: { reason: 'neon_limits' },
      });
    const { maxAutoSpendAtomic, budgetLeftAtomic } = admission.over;
    const most =
      budgetLeftAtomic !== null && budgetLeftAtomic < maxAutoSpendAtomic
        ? budgetLeftAtomic
        : maxAutoSpendAtomic;
    return most < amountAtomic ? most : amountAtomic - 1n;
  };
}

/**
 * What the next call of a resumed job needs at least, by the same estimate the call is fitted by:
 * the history the last call sent (its size in bytes, or four bytes a token where only tokens were
 * kept), room for the person's note and the context Claude Code adds again (about 20 KB), and one
 * floor-sized turn of output. A revision that cannot afford this would fail at its first call and
 * end its conversation, so it is asked about before it is sent.
 */
export async function neonNextCallNeedAtomic(
  dataDir: string,
  job: Pick<ModelJob, 'id'>,
  terms: Parameters<typeof neonPeakQuoteAtomic>[0],
): Promise<bigint> {
  const record = await readNeonRecord(dataDir, job.id);
  const last = record?.calls.at(-1);
  const history = last?.bytes ?? (last ? last.inputTokens * 4 : 0);
  const estimate = neonPeakQuoteAtomic(
    terms,
    history + NEON_RESUME_MARGIN_BYTES,
    NEON_TURN_FLOOR_TOKENS,
  );
  // A call that did not fit measured its own real request: that is what the next try needs.
  const measured = record?.needAtomic !== undefined ? BigInt(record.needAtomic) : 0n;
  return measured > estimate ? measured : estimate;
}
const NEON_RESUME_MARGIN_BYTES = 20_000;
/**
 * What Claude Code puts around a first draft (its system prompt, the tools and the instruction
 * files): about 16,600 input tokens measured in live runs on a one-line draft. It is the floor the
 * door quotes; the real first request is measured when it is sent, and a call it still does not
 * fit is asked about again on the same worker.
 */
const NEON_FIRST_CONTEXT_BYTES = 70_000;

/**
 * What a job's FIRST call needs at least, by the same estimate: the draft's own size, the context
 * Claude Code adds around it, and one floor-sized turn of output. The door asks about it before
 * anything is sent, so a draft the job could not carry is never started.
 */
export const neonFirstCallNeedAtomic = (
  terms: Parameters<typeof neonPeakQuoteAtomic>[0],
  promptBytes: number,
): bigint =>
  neonPeakQuoteAtomic(terms, promptBytes + NEON_FIRST_CONTEXT_BYTES, NEON_TURN_FLOOR_TOKENS);

/** The quote a queued job waits on, or null where it waits on none. */
export async function neonAwaitingApproval(dataDir: string, jobId: string): Promise<string | null> {
  return (await readNeonRecord(dataDir, jobId))?.awaiting ?? null;
}

/** A queued first draft is not runnable until its quote is approved. */
export async function markNeonAwaiting(dataDir: string, jobId: string, quoteId: string) {
  const path = neonRecordPath(dataDir, jobId);
  await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
  await modelLock(`${path}.lock`, async () => {
    const record =
      (await readNeonRecordForWrite(dataDir, jobId)) ?? freshNeonRecord(jobId, Date.now());
    await writePrivate(path, JSON.stringify({ ...record, awaiting: quoteId }));
  });
}

/** The person approved one more ceiling for a job: its next call may spend it. */
export async function grantNeonRoom(
  dataDir: string,
  jobId: string,
  amountAtomic: bigint,
  quoteId?: string,
) {
  const path = neonRecordPath(dataDir, jobId);
  await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
  await modelLock(`${path}.lock`, async () => {
    // A first call asked about at the door is granted before its job has a record.
    const record =
      (await readNeonRecordForWrite(dataDir, jobId)) ?? freshNeonRecord(jobId, Date.now());
    await writePrivate(
      path,
      JSON.stringify({
        ...record,
        // The matching yes is recorded here, and only now is a queued draft runnable.
        awaiting: record.awaiting === quoteId ? undefined : record.awaiting,
        grantedAtomic: (BigInt(record.grantedAtomic) + amountAtomic).toString(),
      }),
    );
  });
}

/** Spend part of a job's approved room on one payment over the per-call limit, once. */
async function editApproval(
  dataDir: string,
  jobId: string,
  change: (left: bigint) => bigint | null,
) {
  const path = neonRecordPath(dataDir, jobId);
  return modelLock(`${path}.lock`, async () => {
    const record = await readNeonRecord(dataDir, jobId);
    if (!record) return false;
    const left = BigInt(record.grantedAtomic) - BigInt(record.approvedSpentAtomic);
    const next = change(left);
    if (next === null) return false;
    await writePrivate(
      path,
      JSON.stringify({
        ...record,
        approvedSpentAtomic: (BigInt(record.approvedSpentAtomic) + next).toString(),
      }),
    );
    return true;
  });
}

/** One call at a time per job, in this process: the budget is read, then spent, in order. */
const chains = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const turn = (chains.get(key) ?? Promise.resolve()).then(run, run);
  const settled = turn.catch(() => undefined);
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return turn;
}

/** What the transport needs of the batch payer. */
export type BatchLike = Pick<BatchSeller, 'post' | 'refund'> & {
  transmitted: boolean;
  signed?: SignedDeposit;
};

export type NeonTransportOptions = {
  dataDir: string;
  ctx: CommandContext;
  provider: WalletProvider;
  authorizer: SpendAuthorizer;
  /** Chain reads the batch scheme's channel checks need. */
  readContract?: ChainRead;
  /** The batch-settlement payer for a seller's saved terms. A test replaces it. */
  batch?: (terms: NeonTerms, admit: (amountAtomic: bigint) => Promise<bigint | void>) => BatchLike;
  /** Whether a job's runner is alive. Production reads the job store's runner lock. */
  liveJob?: (jobId: string) => Promise<boolean>;
  /** The bound on the channel refund at a run's end. Production gives it a few seconds. */
  closeSignal?: () => AbortSignal;
  /** The network seam of the payer. Production leaves it unset. */
  fetchImpl?: typeof fetch;
  /** Where a provider request may go, and how it connects (test seams). */
  destination?: PinnedFetchOptions['destination'];
  pinnedTransport?: PinnedFetchOptions['transport'];
  now?: () => number;
};

/** The saved terms of a job, as its door read them from the provider row. */
export function termsOfJob(job: Pick<ModelJob, 'decision'>): NeonTerms | null {
  const parsed = neonTermsSchema.safeParse(job.decision.neonTerms);
  return parsed.success ? parsed.data : null;
}
const effortOfJob = (job: Pick<ModelJob, 'decision'>): NeonEffort =>
  (NEON_EFFORTS as readonly unknown[]).includes(job.decision.neonEffort)
    ? (job.decision.neonEffort as NeonEffort)
    : NEON_DEFAULT_EFFORT;

/**
 * THE NEON WORKER'S TRANSPORT: what `ModelTransport` is to the DeepSeek worker, for the seller a
 * provider row names. Each model call is one voucher on a batch-settlement channel, signed by the
 * person's own wallet for the row's payee, so the call meets the per-call limit, the daily budget
 * and the job's own ceiling before anything is signed. There is no Tenjin proxy and no routing
 * fee. The terms of the seller are the job's saved terms: this class names no seller.
 *
 * A CALL IS NEVER TRIED AGAIN UNLESS IT IS PROVEN UNPAID. A call that failed before any voucher
 * was signed is marked `uncharged` and the bridge may send it again, as for any request that cost
 * nothing. Once a voucher has left the process the seller may settle it whatever it answers, so
 * the amount stays counted against the job, the call is never marked uncharged and the job ends.
 */
export class NeonTransport {
  /** The jobs this run's calls touched, whose wall time the run adds when it ends. */
  private touched = new Set<string>();
  /** The last paid reply's raw text, kept for the dev probe's failure summary. */
  lastRaw = '';
  private refunds: NeonRefunds;
  private store: ModelJobStore | undefined;
  constructor(private options: NeonTransportOptions) {
    this.refunds = new NeonRefunds({
      dataDir: options.dataDir,
      payer: (terms, salt) =>
        this.batchPayer(terms, async () => refusedDeposit(), undefined, undefined, undefined, salt),
      live:
        options.liveJob ??
        ((jobId) => (this.store ??= new ModelJobStore(options.dataDir)).runnerLive(jobId)),
      ...(options.now ? { now: options.now } : {}),
    });
  }
  /** A Neon job has no router: the marker its settings and its jobs carry in its place. */
  get origin() {
    return NEON_ROUTER_ORIGIN;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }

  async withInferenceRun<T>(
    runId: string,
    signal: AbortSignal,
    run: (transport: NeonTransport) => Promise<T>,
    mark?: (name: 'workerReturned' | 'refundClosed') => void,
  ): Promise<T> {
    signal.throwIfAborted();
    const from = this.now();
    try {
      return await run(this);
    } finally {
      mark?.('workerReturned');
      const ms = this.now() - from;
      for (const id of this.touched)
        await this.update(id, (record) => ({ ...record, wallMs: record.wallMs + ms })).catch(
          () => undefined,
        );
      const ended = [...this.touched];
      this.touched = new Set();
      // THE JOB'S END: what the channel still holds comes back to the wallet now, so nothing
      // waits at the seller between jobs. A refund that fails stays on record for `tenjin refund`.
      await this.refunds
        .settle(ended, (this.options.closeSignal ?? (() => AbortSignal.timeout(NEON_CLOSE_MS)))())
        .catch(() => undefined);
      mark?.('refundClosed');
    }
  }
  async recoverInferenceRefunds(_signal: AbortSignal): Promise<void> {}
  /** Calls are settled or kept `unknown` in the record; `tenjin payments` reconciles them. */
  async reconcile(_job: ModelJob, _signal: AbortSignal): Promise<void> {}
  async requireResumeBudget(job: ModelJob): Promise<void> {
    if (!(await readNeonRecord(this.options.dataDir, job.id)))
      throw new Error('Original Neon record is unavailable; refusing continuation');
    if (!termsOfJob(job)) throw new Error('Original Neon seller terms are unavailable');
  }
  /** The Neon worker has no paid tools: its web search is refused and its fetch has no fallback. */
  async toolCall<T>(
    _job: ModelJob,
    _tool: string,
    _ceilingAtomic: bigint,
    _run: () => Promise<{ value: T; spentAtomic: bigint; uncertain: boolean }>,
  ): Promise<T> {
    throw new ModelCallFailed('The Neon worker pays for no tools', { cause: 'budget' });
  }
  async summary(job: ModelJob) {
    const record = await readNeonRecord(this.options.dataDir, job.id);
    if (!record) return { reservedAtomic: '0', actualAtomic: '0', uncertain: [] as string[] };
    return {
      reservedAtomic: record.spentAtomic,
      actualAtomic: record.settledAtomic,
      uncertain: record.calls.filter((c) => c.settlement === 'unknown').map((c) => `call-${c.n}`),
    };
  }

  private async update(jobId: string, change: (record: NeonRecord) => NeonRecord) {
    const path = neonRecordPath(this.options.dataDir, jobId);
    await modelLock(`${path}.lock`, async () => {
      const record = await readNeonRecord(this.options.dataDir, jobId);
      if (record) await writePrivate(path, JSON.stringify(change(record)));
    });
  }
  private async load(job: ModelJob): Promise<NeonRecord> {
    const { dataDir } = this.options;
    const path = neonRecordPath(dataDir, job.id);
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    return modelLock(`${path}.lock`, async () => {
      const kept = await readNeonRecordForWrite(dataDir, job.id);
      if (kept) return kept;
      const fresh = freshNeonRecord(job.id, this.now());
      await writePrivate(path, JSON.stringify(fresh));
      return fresh;
    });
  }

  /**
   * One model call of the job's worker: `messages` is the worker's own Messages body, already
   * normalized by `workerMessages`. Returns the Anthropic message its child reads.
   */
  async messages(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
    _observe?: unknown,
    _stream?: unknown,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    this.touched.add(job.id);
    return inOrder(job.id, () => this.send(job, messages, signal, beforeSend));
  }

  /** Whether any of these jobs sent a voucher whose charge was never settled. */
  private async leftUnsettled(jobIds: readonly string[]): Promise<boolean> {
    for (const id of jobIds) {
      const record = await readNeonRecord(this.options.dataDir, id);
      if (record?.calls.some((call) => call.settlement === 'unknown')) return true;
    }
    return false;
  }

  /** What a call that did not fit needed, measured from its real request. */
  private async keepNeed(job: ModelJob, needAtomic: bigint) {
    const path = neonRecordPath(this.options.dataDir, job.id);
    await this.load(job);
    await modelLock(`${path}.lock`, async () => {
      const record = await readNeonRecord(this.options.dataDir, job.id);
      if (record)
        await writePrivate(path, JSON.stringify({ ...record, needAtomic: needAtomic.toString() }));
    });
  }

  private async send(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const { dataDir, ctx } = this.options;
    const nothingSigned = (
      message: string,
      detail: ConstructorParameters<typeof ModelCallFailed>[1],
    ) => new ModelCallFailed(message, { ...detail, uncharged: true });
    await beforeSend?.();
    signal.throwIfAborted();
    const terms = termsOfJob(job);
    if (!terms) throw nothingSigned('The job has no seller terms', { cause: 'failed' });
    const current = await modelSettings(dataDir, job.root, 'neon');
    if (!current) throw nothingSigned('Neon is not available here', { cause: 'budget' });
    const record = await this.load(job);
    // THE ROOM OF ONE TURN, by the one rule the handoff asks about before a worker starts (see
    // neon-room.ts): the least of what one channel holds, the job's budget and the per-call limit
    // or day's budget, which the job's unused approval lifts. The output cap is stepped down to
    // fit it, never refused above the floor.
    const settings = await resolveContextSettings(ctx);
    const limits = await neonLimits(ctx, NEON_CHANNEL_DEPOSIT_CAP_ATOMIC, this.options.now);
    const jobLeft =
      (current.maxJobAtomic < BigInt(job.capAtomic)
        ? current.maxJobAtomic
        : BigInt(job.capAtomic)) +
      BigInt(record.grantedAtomic) -
      BigInt(record.spentAtomic);
    const approvedLeft = BigInt(record.grantedAtomic) - BigInt(record.approvedSpentAtomic);
    const { room, approved: needsApproval } = neonRoom(limits, {
      jobLeftAtomic: jobLeft,
      approvedLeftAtomic: approvedLeft,
    });
    const asked =
      typeof messages.max_tokens === 'number' && Number.isInteger(messages.max_tokens)
        ? messages.max_tokens
        : NEON_TURN_MAX_TOKENS;
    const carry: ThoughtCarry = record.signatures;
    const effort = effortOfJob(job);
    // The body's size is the input estimate's basis; the output cap is stepped down to fit.
    const probe = JSON.stringify(chatBody(messages, carry, 1, terms.model, effort));
    const maxTokens = fittingNeonTokens(terms, Buffer.byteLength(probe), asked, room);
    if (maxTokens === null || room <= 0n) {
      // The real request is known now: what it needs is kept, so the next try is asked about at
      // that amount and not at an estimate.
      await this.keepNeed(
        job,
        neonPeakQuoteAtomic(terms, Buffer.byteLength(probe), NEON_TURN_FLOOR_TOKENS),
      ).catch(() => undefined);
      throw nothingSigned('The job ceiling has no room for another Neon call', { cause: 'budget' });
    }
    const chat = chatBody(messages, carry, maxTokens, terms.model, effort);
    const body = JSON.stringify(chat);
    const n = record.calls.length + 1;
    const started = this.now();
    // BEFORE ANY REQUEST: the call as the price rule sizes it, met against the allowlist. The
    // seller's exact ceiling is known only from the 402 of this very request (a payment is
    // accepted only for the price of the body that carries it), so the request is sent to be
    // quoted, and nothing is signed until the limits have passed that ceiling. What is known
    // here is refused here, with nothing sent.
    const pre = await admitPlan(
      [
        {
          amountAtomic: neonPeakQuoteAtomic(terms, Buffer.byteLength(body), maxTokens),
          creator: neonHost(terms),
        },
      ],
      { dataDir, policy: settings.policy, ...(this.options.now ? { now: this.options.now } : {}) },
    );
    if ('refused' in pre) throw nothingSigned(pre.refused.message, { cause: 'budget' });
    // The channel is on record before any money moves, with the terms this job was paid under.
    // A channel an earlier call left a voucher unsettled on (this build retires it at the failure;
    // a record an older build left is found here) is never deposited into again.
    const active = (await this.refunds.entries()).find(
      (entry) => entry.key === channelKey(terms) && !entry.retired,
    );
    // A record an older build left: nothing says when its authorization lapses, so it is held an hour.
    if (active && (await this.leftUnsettled(active.jobIds.slice(-50))))
      await this.refunds.retire(terms, this.now() + 3_600_000);
    const { salt } = await this.refunds.open(job.id, terms);
    // A deposit meets the person's limits like any payment, and is sized to what they admit.
    const batch = this.batchPayer(
      terms,
      depositAdmitter({
        dataDir,
        policy: needsApproval
          ? { ...settings.policy, maxAutoSpendAtomic: room, sessionBudgetAtomic: null }
          : settings.policy,
        creator: neonHost(terms),
        ...(this.options.now ? { now: this.options.now } : {}),
      }),
      canonicalHash({ job: job.id, n, body }),
      approvedLeft > 0n
        ? {
            leftAtomic: approvedLeft,
            consume: (amount) =>
              editApproval(dataDir, job.id, (left) => (amount <= left ? amount : null)),
            restore: async (amount) => {
              await editApproval(dataDir, job.id, () => -amount);
            },
          }
        : undefined,
      // The channel's own config is kept BEFORE the first payment leaves, so a call that was
      // funded and then failed still leaves what a withdrawal needs without asking the seller.
      (channel) => this.refunds.saveChannel(terms, channel),
      salt,
    );
    let answer;
    try {
      answer = await batch.post(
        body,
        AbortSignal.any([signal, AbortSignal.timeout(NEON_CALL_TIMEOUT_MS)]),
        room,
      );
    } catch (error) {
      throw await this.failedCall(
        job,
        n,
        started,
        maxTokens,
        error,
        batch.transmitted,
        room,
        signal,
        batch.signed,
      );
    }
    if (answer.status < 200 || answer.status >= 300) {
      // What the seller said, in a few words, so a failed call is never a mystery again.
      const said = answer.text.replace(/\s+/g, ' ').slice(0, 200);
      await this.note(job, `call ${n}: the seller answered ${answer.status}: ${said}`);
    }
    if (answer.status < 200 || answer.status >= 300)
      throw await this.failedCall(
        job,
        n,
        started,
        maxTokens,
        new CliError('PAYMENT_FAILED', `The seller answered ${answer.status}`, {
          details: { status: answer.status },
        }),
        true,
        answer.ceilingAtomic ?? room,
        signal,
        batch.signed,
      );
    // The real charge where the seller said it; else the ceiling, which it may not exceed.
    const quoted = answer.costAtomic ?? answer.ceilingAtomic ?? 0n;
    this.lastRaw = answer.text;
    let unreadable: NeonReplyInvalid | undefined;
    let usage: NeonUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    let reply: unknown;
    try {
      reply = replyOfBody(answer.text);
      usage = chatUsage(reply, terms.usage);
    } catch (error) {
      if (!(error instanceof NeonReplyInvalid)) throw error;
      unreadable = error;
    }
    // A seller that names the real charge is settled at it; else the call is at its ceiling.
    const settled = answer.costAtomic !== undefined;
    // A seller that named no charge leaves its voucher unsettled: the channel is retired.
    if (!settled)
      await this.refunds
        .retire(terms, batch.signed ? Number(batch.signed.validBefore) * 1000 : undefined)
        .catch(() => undefined);
    if (process.env[NEON_CAPTURE_ENV] === '1')
      await this.capture(job, n, capturedRequest(chat), answer.text).catch(() => undefined);
    // The funded channel's own config is kept, so a withdrawal never has to ask the seller.
    if (answer.channel)
      await this.refunds.saveChannel(terms, answer.channel).catch(() => undefined);
    await this.ledger(job, terms, n, quoted, settled);
    const call: NeonCall = {
      n,
      at: started,
      ...usage,
      ...inputSplit(chat as unknown as Record<string, unknown>, usage.inputTokens),
      maxTokens,
      bytes: Buffer.byteLength(body),
      model: terms.model,
      quotedAtomic: (answer.ceilingAtomic ?? quoted).toString(),
      settledAtomic: settled ? quoted.toString() : null,
      settlement: settled ? 'settled' : 'unknown',
      ok: true,
      ms: this.now() - started,
    };
    let message: Record<string, unknown>;
    try {
      if (unreadable) throw unreadable;
      message = messageOf(reply, carry, terms.usage);
    } catch (error) {
      if (error instanceof NeonNoText) {
        // CHARGED, AND NO TEXT: the turn spent its cap on thought. The call is recorded with its
        // settled charge, counts in the daily budget, and is never sent again.
        await this.record(job, { ...call, ok: false }, carry);
        throw new ModelWorkerStopped({ kind: 'provider_limit', reason: 'output_limit' });
      }
      if (!(error instanceof NeonReplyInvalid)) throw error;
      await this.record(job, { ...call, ok: false }, carry);
      // Paid, and the reply is unusable: never asked again.
      throw new ModelCallFailed(`The seller's reply could not be read: ${error.message}`, {
        cause: 'failed',
        status: answer.status,
      });
    }
    await this.record(job, call, carry);
    return message;
  }

  /**
   * OPT-IN CAPTURE (`TENJIN_NEON_CAPTURE=1` in the environment of `tenjin mcp`): the call's raw
   * response and its request beside the job's record, to see what a turn really carried. The
   * request keeps the system prompt and the tools as sizes. No payment header or signature is
   * ever in either: the body is what the seller's reply carried.
   */
  private async capture(job: ModelJob, n: number, shown: Record<string, unknown>, raw: string) {
    const folder = join(this.options.dataDir, 'model-jobs', `${job.id}.neon-raw`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writePrivate(join(folder, `call-${n}.request.json`), JSON.stringify(shown, null, 1));
    await writePrivate(join(folder, `call-${n}.response.json`), raw);
  }

  /** The batch-settlement payer for one seller's saved terms, made at the call. */
  private batchPayer(
    terms: NeonTerms,
    admit: (amountAtomic: bigint) => Promise<bigint | void>,
    requestKey = `neon:${Date.now()}`,
    approval?: PaymentApproval,
    onChannel?: (channel: ChannelConfig) => Promise<void>,
    salt?: string,
  ): BatchLike {
    if (this.options.batch) return this.options.batch(terms, admit);
    return new BatchSeller({
      dataDir: this.options.dataDir,
      terms,
      provider: this.options.provider,
      admit,
      authorizer: this.options.authorizer,
      requestKey,
      ...(approval ? { approval } : {}),
      ...(onChannel ? { onChannel } : {}),
      ...(salt ? { salt: salt as Hex } : {}),
      ...(this.options.readContract ? { readContract: this.options.readContract } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.destination ? { destination: this.options.destination } : {}),
      ...(this.options.pinnedTransport ? { pinnedTransport: this.options.pinnedTransport } : {}),
    });
  }

  /**
   * A CALL THAT FAILED. Where nothing was sent to the seller beyond the unpaid request, it is
   * proven unpaid and may be tried again (a limit or a policy refusal ends the job as budget). A
   * live 402 that names another payee than the row's signs nothing and ends the job as budget.
   * Once a voucher reached the seller, its ceiling stays counted against the job as uncertain and
   * the call is never tried again.
   */
  private async failedCall(
    job: ModelJob,
    n: number,
    started: number,
    maxTokens: number,
    error: unknown,
    transmitted: boolean,
    atRisk: bigint,
    signal: AbortSignal,
    signed?: SignedDeposit,
  ): Promise<unknown> {
    if (signal.aborted && !transmitted) return signal.reason ?? error;
    if (!transmitted) {
      if (error instanceof PayeeMismatch)
        return new ModelCallFailed(error.message, { cause: 'budget', uncharged: true });
      // The SDK may wrap what a deposit or a policy threw: the whole chain of causes is read.
      const chain: unknown[] = [];
      for (let e: unknown = error; e !== undefined && chain.length < 5; e = (e as Error)?.cause)
        chain.push(e);
      const refused = chain.some(
        (e) =>
          (e instanceof CliError && e.code === 'POLICY_REFUSED') ||
          e instanceof ChannelDepositRefused ||
          (e instanceof Error && /no .*(scheme|network|requirement)|policy/i.test(e.message)),
      );
      // Why, in a few words: the failure was once only "not sent", with nothing to find it by.
      const why = (chain.at(-1) instanceof Error ? (chain.at(-1) as Error).message : '')
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      await this.note(job, `call ${n} not sent: ${why || 'no reason given'}`);
      return new ModelCallFailed(
        `The Neon call was not sent to its seller${why ? `: ${why}` : ''}`,
        { cause: refused ? 'budget' : 'failed', uncharged: true },
      );
    }
    // WHAT THE SELLER HOLDS, kept where a chain read can prove it: a payment that was sent and not
    // answered with a charge is never released on the seller's word, whatever status it gave. The
    // deposit authorization's nonce and expiry go to the paid record `tenjin payments reconcile`
    // reads; after the expiry it asks the token whether the authorization was used, and only an
    // authorization that never was releases this amount. Without one (the voucher spent a channel
    // that was already funded) nothing can prove it, and it stays counted until the window rolls.
    const savedTerms = termsOfJob(job);
    // A voucher left unsettled: the channel is never deposited into again.
    if (savedTerms)
      await this.refunds
        .retire(savedTerms, signed ? Number(signed.validBefore) * 1000 : undefined)
        .catch(() => undefined);
    if (signed?.onlyThroughDeposit && savedTerms)
      await appendPaidRecord(this.options.dataDir, {
        version: 1,
        ts: new Date(this.now()).toISOString(),
        capabilityId: 'neon-worker',
        provider: neonHost(savedTerms),
        label: `${savedTerms.label} worker`,
        source: 'tenjin',
        url: savedTerms.url,
        sent: recordedSent(`neon worker job ${job.id} call ${n}`),
        amountAtomic: atRisk.toString(),
        settlement: 'unknown',
        savedFiles: [],
        payer: signed.from,
        authorization: {
          from: signed.from,
          nonce: signed.nonce,
          validBefore: signed.validBefore,
          network: signed.network,
          asset: signed.asset,
        },
      });
    await this.record(
      job,
      {
        n,
        at: started,
        ...(signed?.onlyThroughDeposit ? { resolvesAt: Number(signed.validBefore) * 1000 } : {}),
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        maxTokens,
        quotedAtomic: atRisk.toString(),
        settledAtomic: null,
        settlement: 'unknown',
        ok: false,
        ms: this.now() - started,
      },
      (await readNeonRecord(this.options.dataDir, job.id))?.signatures ?? {},
    ).catch(() => undefined);
    return new ModelCallFailed(
      'The Neon call failed after its voucher was sent; it stays counted until its charge is read',
      { cause: 'failed' },
    );
  }

  /** Keeps why a call was not sent, never failing the call that reports it. */
  private async note(job: ModelJob, line: string) {
    await this.update(job.id, (record) => ({
      ...record,
      notSent: [...record.notSent, line].slice(-5),
    })).catch(() => undefined);
  }

  /** The amount a call signed, for `tenjin payments` and its reconcile. */
  private async ledger(
    job: ModelJob,
    terms: NeonTerms,
    n: number,
    amountAtomic: bigint,
    settled: boolean,
  ) {
    await appendPaidRecord(this.options.dataDir, {
      version: 1,
      ts: new Date(this.now()).toISOString(),
      capabilityId: 'neon-worker',
      provider: neonHost(terms),
      label: `${terms.label} worker`,
      source: 'tenjin',
      url: terms.url,
      sent: recordedSent(`neon worker job ${job.id} call ${n}`),
      amountAtomic: amountAtomic.toString(),
      settlement: settled ? 'settled' : 'unknown',
      savedFiles: [],
    });
  }

  private async record(job: ModelJob, call: NeonCall, carry: ThoughtCarry) {
    await this.update(job.id, (record) => {
      const spent = BigInt(record.spentAtomic) + BigInt(call.settledAtomic ?? call.quotedAtomic);
      const settled = BigInt(record.settledAtomic) + BigInt(call.settledAtomic ?? '0');
      return {
        ...record,
        // A call that went through meets what it needs: the measured need is spent.
        needAtomic: undefined,
        spentAtomic: spent.toString(),
        settledAtomic: settled.toString(),
        calls: [...record.calls, call].slice(-CALLS_KEPT),
        signatures: carry,
      };
    });
  }
}

const refusedDeposit = () => {
  throw new CliError('POLICY_REFUSED', 'A refund deposits nothing.');
};
