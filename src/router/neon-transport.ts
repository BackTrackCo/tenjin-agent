import type { ChainRead } from './routing-payer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../context';
import { runPay, type PayDeps, type PayArgs } from '../commands/pay';
import { CliError } from '../lib/errors';
import { isRecord } from '../lib/guards';
import { canonicalHash } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import { admitPlan } from '../lib/spend-plan';
import { USDC_ADDRESS } from '../lib/usdc';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import { modelLock, type ModelJob } from './model-job';
import { modelSettings, NEON_ORIGIN } from './model-settings';
import { ModelCallFailed, ModelWorkerStopped } from './model-worker-control';
import { appendPaidRecord, recordedSent, type SignedAuthorization } from './paid';
import { readJsonFile, writePrivate } from './store-files';
import {
  BatchSeller,
  ChannelDepositRefused,
  neonSeller,
  X402INFERENCE_CHAT_URL,
} from './neon-seller';
import {
  capturedMessagesRequest,
  capturedRequest,
  chatBody,
  messageHasNoText,
  messageOfStream,
  messagesRequest,
  NEON_MESSAGES_URL,
  neonRoute,
  type NeonUsage,
  NEON_CAPTURE_ENV,
  chatUsage,
  fittingNeonTokens,
  messageOf,
  NEON_CALL_TIMEOUT_MS,
  NEON_CHAT_URL,
  inputSplit,
  neonLabel,
  neonMaxTokens,
  neonModel,
  NeonNoText,
  NeonReplyInvalid,
  replyOfBody,
  type ThoughtCarry,
} from './neon-chat';

/** The task class every Neon job is recorded under: the worker takes writing jobs. */
export const NEON_TASK_CLASS = 'writing';
/** Calls kept in one job's record: a job has no turn limit, its ceiling is the bound. */
const CALLS_KEPT = 2_000;

const callSchema = z.object({
  n: z.number().int().positive(),
  at: z.number(),
  /** The tokens BlockRun reported for the call; zero where it reported none. */
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  /** Where the input tokens went, shared by bytes: the system part, the tools, the messages. */
  systemTokens: z.number().optional(),
  toolsTokens: z.number().optional(),
  messageTokens: z.number().optional(),
  /** The model that answered the call, as it was asked for. */
  model: z.string().optional(),
  /** Thought tokens counted in the output, where BlockRun reports them. */
  reasoningTokens: z.number().optional(),
  /** The `max_tokens` the call asked for: what BlockRun's quote was sized by. */
  maxTokens: z.number(),
  /** What BlockRun quoted and the wallet signed, atomic USDC. */
  quotedAtomic: z.string().regex(/^\d+$/),
  /** What settled: the quote when the chain or the seller's receipt shows it, else null. */
  settledAtomic: z.string().regex(/^\d+$/).nullable(),
  settlement: z.enum(['settled', 'unknown']),
  ok: z.boolean(),
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
  settledAtomic: z.string().regex(/^\d+$/),
  calls: z.array(callSchema),
  signatures: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type NeonRecord = z.infer<typeof recordSchema>;

export const neonRecordPath = (dataDir: string, jobId: string) =>
  join(dataDir, 'model-jobs', `${jobId}.neon.json`);

export async function readNeonRecord(dataDir: string, jobId: string): Promise<NeonRecord | null> {
  const parsed = recordSchema.safeParse(
    await readJsonFile(neonRecordPath(dataDir, jobId), 4_000_000),
  );
  return parsed.success ? parsed.data : null;
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
export type BatchLike = Pick<BatchSeller, 'post' | 'refund'> & { transmitted: boolean };

export type NeonTransportOptions = {
  dataDir: string;
  ctx: CommandContext;
  provider: WalletProvider;
  authorizer: SpendAuthorizer;
  /** Chain reads the batch scheme's channel checks need. */
  readContract?: ChainRead;
  /** The batch-settlement payer for the x402inference seller. A test replaces it. */
  batch?: (admit: (amountAtomic: bigint) => Promise<void>) => BatchLike;
  /** Payment seams: the network and the chain read. Production leaves them unset. */
  payDeps?: Pick<PayDeps, 'fetchImpl' | 'chainFetch' | 'destination'>;
  /** The payer. A test replaces it. */
  pay?: typeof runPay;
  now?: () => number;
};

/**
 * THE NEON WORKER'S TRANSPORT: what `ModelTransport` is to the DeepSeek worker, for BlockRun.
 * Each model call is one x402 `exact` payment from the person's own wallet to BlockRun, made
 * through the CLI's own payer, so the call meets the per-call limit, the daily budget and the
 * allowlist before anything is signed, and the job's own ceiling on top. There is no Tenjin
 * proxy and no routing fee.
 *
 * `exact` and not `upto`: BlockRun offers `upto` on Base only for non-streaming Claude and
 * DeepSeek chat models (its documentation, and the unpaid 402 for Neon lists `exact` alone).
 * The quote is therefore the estimated input plus the whole `max_tokens`, which is why every
 * turn's output is capped ({@link NEON_TURN_MAX_TOKENS}).
 *
 * A CALL IS NEVER TRIED AGAIN UNLESS IT IS PROVEN UNPAID. A call that failed before any
 * authorization was signed is marked `uncharged` and the bridge may send it again, as for any
 * request that cost nothing. Once an authorization has left the process the seller may settle
 * it whatever it answers, so the amount stays counted against the job, the call is never
 * marked uncharged and the job ends.
 */
export class NeonTransport {
  /** The jobs this run's calls touched, whose wall time the run adds when it ends. */
  private touched = new Set<string>();
  /** The last paid reply's raw text, kept for the dev probe's failure summary. */
  lastRaw = '';
  constructor(private options: NeonTransportOptions) {}
  /** The seller's origin: the consent and the job's decision name it. */
  get origin() {
    return NEON_ORIGIN;
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
      this.touched = new Set();
      // Nothing is held open for a refund: a call is paid once, at its quote.
      mark?.('refundClosed');
    }
  }
  async recoverInferenceRefunds(_signal: AbortSignal): Promise<void> {}
  /** Calls are settled or kept `unknown` in the record; `tenjin payments` reconciles them. */
  async reconcile(_job: ModelJob, _signal: AbortSignal): Promise<void> {}
  async requireResumeBudget(job: ModelJob): Promise<void> {
    if (!(await readNeonRecord(this.options.dataDir, job.id)))
      throw new Error('Original Neon record is unavailable; refusing continuation');
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
      const kept = await readNeonRecord(dataDir, job.id);
      if (kept) return kept;
      const fresh: NeonRecord = {
        version: 1,
        jobId: job.id,
        taskClass: NEON_TASK_CLASS,
        startedAt: this.now(),
        wallMs: 0,
        spentAtomic: '0',
        settledAtomic: '0',
        calls: [],
        signatures: {},
      };
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
    const current = await modelSettings(dataDir, job.root, 'neon');
    if (!current) throw nothingSigned('Neon consent was revoked', { cause: 'budget' });
    const cap =
      current.maxJobAtomic < BigInt(job.capAtomic) ? current.maxJobAtomic : BigInt(job.capAtomic);
    const record = await this.load(job);
    const remaining = cap - BigInt(record.spentAtomic);
    const asked =
      typeof messages.max_tokens === 'number' && Number.isInteger(messages.max_tokens)
        ? messages.max_tokens
        : neonMaxTokens();
    // The body's size is the input estimate's basis; the output cap is stepped down to fit.
    const carry: ThoughtCarry = record.signatures;
    const seller = neonSeller();
    // x402inference takes chat completions only, as a plain reply carrying its real charge.
    const route = seller === 'x402inference' ? 'chat' : neonRoute();
    const plain = seller === 'x402inference';
    const probe = JSON.stringify(
      route === 'chat' ? chatBody(messages, carry, 1, !plain) : messagesRequest(messages, 1),
    );
    const maxTokens = fittingNeonTokens(Buffer.byteLength(probe), asked, remaining);
    if (maxTokens === null || remaining <= 0n)
      throw nothingSigned('The job ceiling has no room for another Neon call', { cause: 'budget' });
    const chat = route === 'chat' ? chatBody(messages, carry, maxTokens, !plain) : undefined;
    const wire = chat ?? messagesRequest(messages, maxTokens);
    const body = JSON.stringify(wire);
    const n = record.calls.length + 1;
    const started = this.now();
    const settings = await resolveContextSettings(ctx);
    const admitAmount = async (amountAtomic: bigint) => {
      const admission = await admitPlan(
        [{ amountAtomic, creator: new URL(plain ? X402INFERENCE_CHAT_URL : NEON_CHAT_URL).host }],
        {
          dataDir,
          policy: settings.policy,
          ...(this.options.now ? { now: this.options.now } : {}),
        },
      );
      return admission;
    };
    const args: PayArgs = {
      url: route === 'chat' ? NEON_CHAT_URL : NEON_MESSAGES_URL,
      method: 'POST',
      rawBody: body,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      terms: {
        source: 'BlockRun',
        maxAmountAtomic: remaining.toString(),
        network: 'eip155:8453',
        asset: USDC_ADDRESS,
      },
      execution: 'router',
      // The person's own limits meet this payment at the live price, before it is signed:
      // the per-call limit, the daily budget and the allowlist.
      admit: async (amountAtomic) => {
        const admission = await admitAmount(amountAtomic);
        if ('admitted' in admission) return admission.admitted[0]!;
        throw new CliError(
          'POLICY_REFUSED',
          'over' in admission
            ? 'This Neon call is over your spend limits; nothing was paid.'
            : admission.refused.message,
          { details: { reason: 'neon_limits' } },
        );
      },
      requestKey: canonicalHash({ job: job.id, n, body }),
      timeoutMs: NEON_CALL_TIMEOUT_MS,
      printBody: true,
    };
    let paid: { data: unknown };
    let sellerCharge: { ceiling?: bigint; cost?: bigint } | undefined;
    if (plain) {
      // The batch-settlement seller: a deposit meets the person's limits like any payment.
      const batch = this.batchPayer(
        async (amountAtomic) => {
          const admission = await admitAmount(amountAtomic);
          if (!('admitted' in admission))
            throw new CliError(
              'POLICY_REFUSED',
              'over' in admission
                ? 'This Neon deposit is over your spend limits; nothing was paid.'
                : admission.refused.message,
              { details: { reason: 'neon_limits' } },
            );
        },
        canonicalHash({ job: job.id, n, body }),
      );
      let answer;
      try {
        answer = await batch.post(body, signal, remaining);
      } catch (error) {
        throw await this.failedBatch(
          job,
          n,
          started,
          maxTokens,
          error,
          batch.transmitted,
          remaining,
          signal,
        );
      }
      if (answer.status < 200 || answer.status >= 300)
        throw await this.failedBatch(
          job,
          n,
          started,
          maxTokens,
          new CliError('PAYMENT_FAILED', `x402inference answered ${answer.status}`, {
            details: { status: answer.status },
          }),
          true,
          answer.ceilingAtomic ?? remaining,
          signal,
        );
      sellerCharge = {
        ...(answer.ceilingAtomic !== undefined ? { ceiling: answer.ceilingAtomic } : {}),
        ...(answer.costAtomic !== undefined ? { cost: answer.costAtomic } : {}),
      };
      paid = {
        data: {
          status: answer.status,
          bodyText: answer.text,
          // The real charge where the seller said it; else the ceiling, which it may not exceed.
          amountPaid: { atomic: (answer.costAtomic ?? answer.ceilingAtomic ?? 0n).toString() },
        },
      };
    } else
      try {
        paid = await (this.options.pay ?? runPay)(args, ctx, {
          provider: this.options.provider,
          authorizer: this.options.authorizer,
          signal,
          confirm: async () => false,
          ...(this.options.payDeps?.fetchImpl ? { fetchImpl: this.options.payDeps.fetchImpl } : {}),
          ...(this.options.payDeps?.chainFetch
            ? { chainFetch: this.options.payDeps.chainFetch }
            : {}),
          ...(this.options.payDeps?.destination
            ? { destination: this.options.payDeps.destination }
            : {}),
        });
      } catch (error) {
        throw await this.failed(job, n, started, maxTokens, error, signal);
      }
    const data = paid.data as {
      status?: number;
      body?: unknown;
      bodyText?: string;
      settlementTxHash?: string;
      payer?: string;
      authorization?: SignedAuthorization;
      amountPaid?: { atomic?: string };
    };
    const quoted = BigInt(data.amountPaid?.atomic ?? '0');
    this.lastRaw = typeof data.bodyText === 'string' ? data.bodyText : '';
    // A streamed reply arrives as text: its events are folded into the whole reply.
    let unreadable: NeonReplyInvalid | undefined;
    let usage: NeonUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    let reply: unknown = data.body;
    let folded: Record<string, unknown> | undefined;
    try {
      if (route === 'messages') {
        const read = messageOfStream(
          typeof data.bodyText === 'string' ? data.bodyText : JSON.stringify(data.body ?? ''),
        );
        folded = read.message;
        usage = read.usage;
      } else {
        if (reply === undefined && typeof data.bodyText === 'string')
          reply = replyOfBody(data.bodyText);
        usage = chatUsage(reply);
      }
    } catch (error) {
      if (!(error instanceof NeonReplyInvalid)) throw error;
      unreadable = error;
    }
    // A streamed reply may carry no receipt header. BlockRun charges an exact stream when its
    // output starts, so a 2xx that came back with a body is a charge of the quote: never
    // recorded as unknown, nor reported as nothing spent. A receipt, when sent, adds its tx.
    // A seller that names the real charge is settled at it; else a paid stream is at its quote.
    const settled = sellerCharge === undefined || sellerCharge.cost !== undefined;
    if (process.env[NEON_CAPTURE_ENV] === '1')
      await this.capture(
        job,
        n,
        chat ? capturedRequest(chat) : capturedMessagesRequest(wire),
        typeof data.bodyText === 'string' ? data.bodyText : '',
      ).catch(() => undefined);
    await this.ledger(job, n, quoted, data, settled);
    const call: NeonCall = {
      n,
      at: started,
      ...usage,
      ...inputSplit(wire, usage.inputTokens),
      maxTokens,
      model: neonModel(),
      quotedAtomic: (sellerCharge?.ceiling ?? quoted).toString(),
      settledAtomic: settled ? quoted.toString() : null,
      settlement: settled ? 'settled' : 'unknown',
      ok: true,
      ms: this.now() - started,
      ...(data.settlementTxHash !== undefined ? { txHash: data.settlementTxHash } : {}),
    };
    let message: Record<string, unknown>;
    try {
      if (unreadable) throw unreadable;
      if (folded) {
        if (messageHasNoText(folded))
          throw new NeonNoText('The turn reached the output cap with no text');
        message = folded;
      } else message = messageOf(reply, carry);
    } catch (error) {
      if (error instanceof NeonNoText) {
        await this.record(job, { ...call, ok: false }, carry);
        throw new ModelWorkerStopped({ kind: 'provider_limit', reason: 'output_limit' });
      }
      if (!(error instanceof NeonReplyInvalid)) throw error;
      await this.record(job, { ...call, ok: false }, carry);
      // Paid, and the reply is unusable: never asked again.
      throw new ModelCallFailed(`BlockRun's reply could not be read: ${error.message}`, {
        cause: 'failed',
        ...(data.status !== undefined ? { status: data.status } : {}),
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
    await writePrivate(join(folder, `call-${n}.response.sse`), raw);
  }

  /** The batch-settlement payer, made at the call. */
  private batchPayer(
    admit: (amountAtomic: bigint) => Promise<void>,
    requestKey = `x402inference:${Date.now()}`,
  ): BatchLike {
    if (this.options.batch) return this.options.batch(admit);
    return new BatchSeller({
      dataDir: this.options.dataDir,
      provider: this.options.provider,
      admit,
      authorizer: this.options.authorizer,
      requestKey,
      ...(this.options.readContract ? { readContract: this.options.readContract } : {}),
      ...(this.options.payDeps?.fetchImpl ? { fetchImpl: this.options.payDeps.fetchImpl } : {}),
    });
  }

  /** The cooperative refund of the x402inference channel's remainder. */
  async refundChannel(signal: AbortSignal) {
    return this.batchPayer(async () => {
      throw new CliError('POLICY_REFUSED', 'A refund deposits nothing.');
    }).refund(signal);
  }

  /**
   * A BATCH CALL THAT FAILED. Where nothing was sent to the seller beyond the unpaid request, it
   * is proven unpaid and may be tried again (a limit or a policy refusal ends the job as
   * budget). Once a voucher reached the seller, its ceiling stays counted against the job as
   * uncertain and the call is never tried again.
   */
  private async failedBatch(
    job: ModelJob,
    n: number,
    started: number,
    maxTokens: number,
    error: unknown,
    transmitted: boolean,
    atRisk: bigint,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted && !transmitted) return signal.reason ?? error;
    if (!transmitted) {
      const refused =
        (error instanceof CliError && error.code === 'POLICY_REFUSED') ||
        error instanceof ChannelDepositRefused ||
        (error instanceof Error && /no .*(scheme|network|requirement)|policy/i.test(error.message));
      return new ModelCallFailed('The Neon call was not sent to its seller', {
        cause: refused ? 'budget' : 'failed',
        uncharged: true,
      });
    }
    await this.record(
      job,
      {
        n,
        at: started,
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

  /** The amount a call signed, for `tenjin payments` and its reconcile. */
  private async ledger(
    job: ModelJob,
    n: number,
    amountAtomic: bigint,
    paid: { settlementTxHash?: string; payer?: string; authorization?: SignedAuthorization },
    settled: boolean,
  ) {
    await appendPaidRecord(this.options.dataDir, {
      version: 1,
      ts: new Date(this.now()).toISOString(),
      capabilityId: 'neon-worker',
      provider: new URL(neonSeller() === 'x402inference' ? X402INFERENCE_CHAT_URL : NEON_CHAT_URL)
        .host,
      label: `${neonLabel(neonModel())} worker`,
      source: 'tenjin',
      url: neonSeller() === 'x402inference' ? X402INFERENCE_CHAT_URL : NEON_CHAT_URL,
      sent: recordedSent(`neon worker job ${job.id} call ${n}`),
      amountAtomic: amountAtomic.toString(),
      ...(paid.settlementTxHash !== undefined ? { txHash: paid.settlementTxHash } : {}),
      settlement: settled ? 'settled' : 'unknown',
      savedFiles: [],
      ...(paid.payer !== undefined ? { payer: paid.payer } : {}),
      ...(paid.authorization !== undefined ? { authorization: paid.authorization } : {}),
    });
  }

  private async record(job: ModelJob, call: NeonCall, carry: ThoughtCarry) {
    await this.update(job.id, (record) => {
      const spent = BigInt(record.spentAtomic) + BigInt(call.settledAtomic ?? call.quotedAtomic);
      const settled = BigInt(record.settledAtomic) + BigInt(call.settledAtomic ?? '0');
      return {
        ...record,
        spentAtomic: spent.toString(),
        settledAtomic: settled.toString(),
        calls: [...record.calls, call].slice(-CALLS_KEPT),
        signatures: carry,
      };
    });
  }

  /**
   * WHY A PAYMENT FAILED, as the bridge reads it. A failure that signed nothing is proven
   * unpaid (`uncharged`). A failure that carries an amount signed an authorization: it stays
   * counted against the job as uncertain, and the call is not repeated.
   */
  private async failed(
    job: ModelJob,
    n: number,
    started: number,
    maxTokens: number,
    error: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted && !(error instanceof CliError && amountOf(error) !== undefined))
      return signal.reason ?? error;
    if (!(error instanceof CliError))
      // Unknown whether a payment left: never proven unpaid, never repeated.
      return new ModelCallFailed('The Neon call failed and may have been charged', {
        cause: 'failed',
      });
    const risk = amountOf(error);
    if (risk === undefined) {
      const status = statusOf(error);
      return new ModelCallFailed(`The Neon call was not paid: ${error.code}`, {
        cause:
          error.code === 'POLICY_REFUSED' ||
          error.code === 'REFUSED' ||
          // The live quote is above the job's remaining ceiling: nothing was signed, and the
          // same request is quoted the same, so it is never tried again.
          error.code === 'REGISTRY_MISMATCH'
            ? 'budget'
            : error.code === 'PAYMENT_FAILED'
              ? 'payment_refused'
              : 'failed',
        uncharged: true,
        ...(status !== undefined ? { status } : {}),
      });
    }
    const details = error.details as { settlement?: string; reportedTxHash?: string };
    const settled = details.settlement === 'settled';
    await this.ledger(
      job,
      n,
      risk,
      {
        ...((error.details as { payer?: string })?.payer !== undefined
          ? { payer: (error.details as { payer: string }).payer }
          : {}),
        ...((error.details as { authorization?: SignedAuthorization })?.authorization !== undefined
          ? {
              authorization: (error.details as { authorization: SignedAuthorization })
                .authorization,
            }
          : {}),
      },
      settled,
    );
    await this.record(
      job,
      {
        n,
        at: started,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        maxTokens,
        quotedAtomic: risk.toString(),
        settledAtomic: settled ? risk.toString() : null,
        settlement: settled ? 'settled' : 'unknown',
        ok: false,
        ms: this.now() - started,
      },
      (await readNeonRecord(this.options.dataDir, job.id))?.signatures ?? {},
    ).catch(() => undefined);
    const status = statusOf(error);
    return new ModelCallFailed(
      'The Neon call failed after its payment was signed; it stays counted until its receipt is read',
      { cause: 'failed', ...(status !== undefined ? { status } : {}) },
    );
  }
}

/** The amount an error says a signed authorization carried, or undefined where none left. */
function amountOf(error: CliError): bigint | undefined {
  const value = isRecord(error.details) ? error.details.amountAtomic : undefined;
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;
}
function statusOf(error: CliError): number | undefined {
  const value = isRecord(error.details) ? error.details.status : undefined;
  return typeof value === 'number' && value >= 100 && value <= 599 ? value : undefined;
}
