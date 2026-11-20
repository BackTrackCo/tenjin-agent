import { lstat, mkdir } from 'node:fs/promises';
import { modelSettings } from './model-settings';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { RoutingPayerDeps } from './routing-payer';
import { LocalSendBlocked, RoutingPayer as Payer } from './routing-payer';
import { paidCallDispatcher } from './paid-call-dispatcher';
import { readMessagesStream, streamIdleMs, type StreamEvent } from './model-stream';
import { readJsonFile, writePrivate } from './store-files';
import { canonicalHash } from '../lib/request-schema';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import { z } from 'zod';
import { modelLock, routingAuthorizedAtomic, type ModelJob } from './model-job';
import { modelInferenceRunScope } from './model-channel';
import { withFileLock } from '../lib/lock';
import { RouteSkipped } from './decision';
import { ROUTING_FEE_CEILING_ATOMIC } from './fee';
import {
  fittingOutputTokens,
  MODEL_MESSAGES_RESULT_BYTES,
  MODEL_MESSAGES_RESULT_BYTES_MAX,
  MODEL_OUTPUT_FLOOR_TOKENS,
  paidCallTimeoutMs,
  MODEL_RESPONSE_ENVELOPE_BYTES,
} from './model-limits';
import {
  MODEL_CUT_REPLY_CODES,
  MODEL_REFUSED_CODE,
  ModelCallFailed,
  retryAfterMs,
  timedOut,
} from './model-worker-control';
import { ModelRefundJournal, modelRefundRunLock } from './model-refund';
import type { ModelCallTiming } from './model-worker-diagnostics';
import { advertisedCallLimit, ModelPace, type PaceClock } from './model-pace';

/**
 * The router's codes for a paid model call the provider failed (its `model_inference_failed`,
 * `incomplete_model_response`, also an empty reply, and `model_response_too_large`),
 * refused to answer (`model_refused`) or whose reply the router cut (`model_stream_idle`,
 * `model_deadline_exceeded`): it marks that call's record with no charge and settles
 * nothing on the error answer.
 */
const PROVIDER_FAILURES = new Set([
  'model_inference_failed',
  'incomplete_model_response',
  'model_response_too_large',
  MODEL_REFUSED_CODE,
  ...MODEL_CUT_REPLY_CODES,
]);

/**
 * THE RESULT SIZE A MESSAGES CALL STATES (`maxResultBytes`): the size the job's offer says
 * its router honours, up to what this CLI reads. The router then fails a larger reply
 * before it charges for it. The offer always names it; one that does not is invalid.
 */
function statedResultBytes(job: ModelJob): number {
  const honoured = job.decision.maxResultBytes;
  if (
    typeof honoured !== 'number' ||
    !Number.isSafeInteger(honoured) ||
    honoured < MODEL_MESSAGES_RESULT_BYTES
  )
    throw new Error('The offer names no result size');
  return Math.min(honoured, MODEL_MESSAGES_RESULT_BYTES_MAX);
}

/**
 * The jobs whose budget file this process has read or written. A job in this set has a run
 * under way, so its budget file is never absent by design: a missing one is treated as
 * damage, never as a fresh budget.
 */
const budgetsKept = new Set<string>();
async function saveBudget(id: string, path: string, state: unknown): Promise<void> {
  await writePrivate(path, JSON.stringify(state));
  budgetsKept.add(id);
}

/** An error answer's fixed code (`{error: {code}}`), never its message. */
async function errorCode(response: Response): Promise<{ code?: string }> {
  try {
    const code = ((await response.json()) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? { code } : {};
  } catch {
    return {};
  }
}

/** The most a job may charge: the job's own cap, or a lower ceiling the consent now holds. */
function jobCap(current: { maxJobAtomic: bigint }, job: { capAtomic: string }): bigint {
  return current.maxJobAtomic < BigInt(job.capAtomic)
    ? current.maxJobAtomic
    : BigInt(job.capAtomic);
}

/** The router's record says a call cost nothing: its voucher cancelled, or it failed unpaid. */
function costNothing(server: { state: string; voucherState: string }): boolean {
  return (
    server.voucherState === 'cancelled' ||
    (server.state === 'unknown' && server.voucherState !== 'accepted')
  );
}

/**
 * THE PROOF THAT A CUT REPLY COST NOTHING (`model_stream_idle`, `model_deadline_exceeded`):
 * the voucher cancelled together with a zero charge, which the router writes for both
 * cuts. `state` reads `unknown` for every cut, so it proves nothing, and a record still
 * `running` or a voucher still `pending` means a write the router did not finish: nothing
 * was charged then either, but the record does not say so, and the call stays uncertain.
 */
function cutCostNothing(server: { voucherState: string; actualAtomic: string }): boolean {
  return server.voucherState === 'cancelled' && server.actualAtomic === '0';
}

const budgetSchema = z.object({
  charged: z.string().regex(/^\d+$/),
  calls: z.record(
    z.string(),
    z.object({
      invocationId: z.uuid(),
      quote: z.string().regex(/^\d+$/),
      completed: z.boolean().optional(),
      actual: z.string().regex(/^\d+$/).optional(),
      /** A router tool a worker's native tool paid for (`toolCall`), by its catalog id;
       *  absent for a model call. Its id is local: the model proxy holds no record of it. */
      tool: z.string().min(1).max(200).optional(),
      /** Events of this call reached its caller, or the router cut its reply: the call is
       *  released only on the strict proof (a cancelled voucher with a zero charge), by
       *  `reconcile` as at the call. */
      strict: z.literal(true).optional(),
    }),
  ),
});
type Budget = z.infer<typeof budgetSchema>;
type InFlightInvocation = {
  abort: AbortController;
  callers: number;
  result: Promise<Record<string, unknown>>;
};

/** A bounded read is required even on our own server: provider messages are untrusted. */
async function boundedJson(
  response: Response,
  limit = MODEL_RESPONSE_ENVELOPE_BYTES,
): Promise<unknown> {
  if (!response.body) throw new Error('Empty invocation receipt');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Invocation receipt exceeds size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function boundedResponse(response: Response, limit = MODEL_RESPONSE_ENVELOPE_BYTES): Response {
  if (!response.body) return response;
  let size = 0;
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > limit) throw new Error('Model response exceeds size limit');
          controller.enqueue(chunk);
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

/**
 * WHAT A JOB'S ROUTING CALL COULD HAVE CHARGED, which its budget starts from: the amount this
 * client authorized for that call, recorded when it was made. An offer's own fee cannot
 * lower it.
 */
const routingExposure = (job: ModelJob): bigint => routingAuthorizedAtomic(job.decision);

/** Job ceiling survives process death. Reserve before sending, retain uncertainty. */
/** A reserved quote that no longer fits the job's cap as it stands when its turn to pay comes. */
class QuoteOverCap extends Error {}
/**
 * How old a quote may be when its paid request is signed, for a router that counts calls
 * at the quote: it keeps the place of a counted quote for 120 s.
 */
const QUOTE_FRESH_MS = 100_000;

export class ModelTransport {
  private routing: Payer;
  /** This wallet's count of sends against the router's call rate, shared by every process. */
  private readonly pace: ModelPace;
  /** Local waiters only. The persisted reservation remains authoritative across transports. */
  private readonly invocations = new Map<string, InFlightInvocation>();
  constructor(
    private options: {
      dataDir: string;
      baseUrl: string;
      payerDeps: RoutingPayerDeps;
      inferenceRun?: string;
      /** The pace's clock and wait: the real ones unless a test drives them. */
      paceClock?: PaceClock;
    },
  ) {
    this.pace = new ModelPace(options.dataDir, options.baseUrl, options.paceClock);
    this.routing = new Payer({
      ...options.payerDeps,
      modelLane: {
        path: '/api/model-router/route',
        ceilingAtomic: ROUTING_FEE_CEILING_ATOMIC,
        origin: this.origin,
      },
    });
  }
  get origin() {
    return new URL(this.options.baseUrl).origin;
  }
  private refundJournal() {
    return new ModelRefundJournal(this.options.dataDir, this.origin, this.options.payerDeps);
  }

  /** The run lock outlives its individual requests so recovery cannot drain a live worker. */
  async withInferenceRun<T>(
    runId: string,
    signal: AbortSignal,
    run: (transport: ModelTransport) => Promise<T>,
    /** Diagnostics only: when the run returned, and when the run's channel closed. */
    mark?: (name: 'workerReturned' | 'refundClosed') => void,
  ): Promise<T> {
    const journal = this.refundJournal();
    // A refund an earlier run left pending is tried again at every accept, in the background:
    // a run's lock keeps it off a live run's channel, and it never delays this one.
    void journal.recoverPending(AbortSignal.timeout(15_000)).catch(() => undefined);
    const lock = modelRefundRunLock(this.options.dataDir, this.origin, runId);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const transport = new ModelTransport({ ...this.options, inferenceRun: runId });
    let entered = false;
    try {
      return await withFileLock(
        lock,
        async () => {
          entered = true;
          return run(transport).finally(() => mark?.('workerReturned'));
        },
        { signal, takeOverDead: true },
      );
    } finally {
      // The worker may have been cancelled. Refund settlement gets its own bounded signal.
      // A failed attempt leaves the durable record for recovery rather than changing the result.
      if (entered) await journal.close(runId, AbortSignal.timeout(8_000)).catch(() => undefined);
      mark?.('refundClosed');
    }
  }

  async recoverInferenceRefunds(signal: AbortSignal) {
    await this.refundJournal().recoverPending(signal);
  }

  /** A continuation must retain every old charge and uncertain reservation. */
  async requireResumeBudget(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    await modelLock(`${path}.lock`, async () => {
      if (!budgetSchema.safeParse(await readJsonFile(path, 1_000_000)).success)
        throw new Error('Original model budget is unavailable; refusing continuation');
    });
  }
  async route(
    body: unknown,
    signal?: AbortSignal,
    beforeSend?: () => Promise<void>,
    /** Diagnostics only: the milliseconds of each HTTP round trip the decision call made. */
    fetchMs?: number[],
    /** A lower ceiling for this call than the routing fee's own, from the job's cap. */
    limitAtomic?: bigint,
  ): Promise<{ json: unknown; authorizedAtomic: bigint }> {
    signal?.throwIfAborted();
    const route = this.routing.routeFor(this.options.baseUrl, limitAtomic);
    let result;
    try {
      const fetchFn = this.options.payerDeps.fetchImpl ?? fetch;
      const guardedFetch: typeof fetch = async (input, init) => {
        try {
          await beforeSend?.();
          signal?.throwIfAborted();
          init?.signal?.throwIfAborted();
        } catch (cause) {
          throw new LocalSendBlocked(cause);
        }
        const sent = performance.now();
        return fetchFn(input, {
          ...init,
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(init?.signal ? [init.signal] : []),
          ]),
        }).finally(() => fetchMs?.push(performance.now() - sent));
      };
      result = await route.send(
        new URL('/api/model-router/route', this.options.baseUrl).toString(),
        {
          method: 'POST',
          jsonBody: body,
          timeoutMs: 5000,
          blockRedirects: true,
          fetchImpl: guardedFetch,
        },
      );
      signal?.throwIfAborted();
    } finally {
      // Lifecycle fences wait until any already signed accounting is drained.
      await this.routing.idle();
    }
    if (!result.ok || result.status !== 200)
      throw new Error('Model router unavailable; keep native');
    return { json: result.json, authorizedAtomic: route.authorized?.() ?? 0n };
  }
  async messages(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
    /** Diagnostics only: where this call's time went, told once when the call ends. */
    observe?: (timing: ModelCallTiming) => void,
    /** Provider events as they arrive, for a streamed worker turn. The call still ends with
     *  the whole answer; this only carries its events early. A caller that joins a call
     *  already in flight gets none. */
    stream?: (event: StreamEvent) => void,
  ) {
    return this.invoke(job, messages, signal, beforeSend, observe, stream);
  }
  private async invoke(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
    observe?: (timing: ModelCallTiming) => void,
    stream?: (event: StreamEvent) => void,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    // Do not share across changed job authority, even when the provider body is identical.
    const key = canonicalHash({ job, messages });
    let invocation = this.invocations.get(key);
    if (!invocation) {
      const abort = new AbortController();
      const timing: ModelCallTiming = {};
      const result = this.invokeStreamed(
        structuredClone(job),
        structuredClone(messages),
        abort.signal,
        beforeSend,
        timing,
        // Only the caller that starts the call is given its events.
        stream,
      ).finally(() => {
        if (this.invocations.get(key)?.abort === abort) this.invocations.delete(key);
        try {
          observe?.(timing);
        } catch {
          // Diagnostics change nothing.
        }
      });
      invocation = { abort, callers: 0, result };
      this.invocations.set(key, invocation);
    }
    const owned = invocation;
    owned.callers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const detach = () => {
        if (settled) return false;
        settled = true;
        owned.callers--;
        signal.removeEventListener('abort', cancel);
        return true;
      };
      const cancel = () => {
        if (!detach()) return;
        // One disconnected HTTP caller cannot cancel a live peer's paid request.
        if (owned.callers === 0) {
          owned.abort.abort(signal.reason);
          // The last owner must still drain any signing/accounting already in progress.
          void owned.result.then(
            () => reject(signal.reason),
            () => reject(signal.reason),
          );
        } else reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      owned.result.then(
        (value) => {
          if (!detach()) return;
          try {
            // Consumers must not mutate another caller's response or the shared result.
            resolve(structuredClone(value));
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          if (detach()) reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  }
  /**
   * THE CALL WITH ITS STREAM, when the caller wants events. A call that failed after
   * events had left says so (`relayed`), so it is never tried again.
   */
  private async invokeStreamed(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend: (() => Promise<void>) | undefined,
    timing: ModelCallTiming,
    stream: ((event: StreamEvent) => void) | undefined,
  ) {
    // Each attempt starts from the request as the worker made it: the output cap is stepped
    // down in the request an attempt is given, and the call's identity is its hash, so a retry
    // that inherited the lowered cap would reserve under another hash than a plain resend.
    const original = structuredClone(messages);
    const seen = { relayed: false };
    const relay =
      stream === undefined
        ? undefined
        : (event: StreamEvent) => {
            seen.relayed = true;
            stream(event);
          };
    try {
      return await this.invokeOnce(
        job,
        structuredClone(original),
        signal,
        beforeSend,
        timing,
        relay,
      );
    } catch (error) {
      if (seen.relayed && error instanceof ModelCallFailed) error.detail.relayed = true;
      throw error;
    }
  }
  private async invokeOnce(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
    timing: ModelCallTiming = {},
    relay?: (event: StreamEvent) => void,
  ) {
    signal.throwIfAborted();
    // Diagnostics only: each step's milliseconds, read from a monotonic clock.
    let stepFrom = performance.now();
    const step = (
      name: Exclude<
        keyof ModelCallTiming,
        'fetches' | 'requestBytes' | 'outputCap' | 'paceWaitMs' | 'requoteMs' | 'ttfbMs'
      >,
    ) => {
      const now = performance.now();
      timing[name] = (timing[name] ?? 0) + now - stepFrom;
      stepFrom = now;
    };
    const endpoint = '/api/model-proxy/messages';
    const resultLimit = MODEL_RESPONSE_ENVELOPE_BYTES;
    const stated = statedResultBytes(job);
    const readable = stated ?? MODEL_MESSAGES_RESULT_BYTES;

    const { dataDir, baseUrl, payerDeps, inferenceRun } = this.options;
    // Every call runs inside its run's own channel, which is refunded when the run ends.
    if (inferenceRun === undefined)
      throw new Error('A Messages call runs only inside an inference run');
    const journal = this.refundJournal();
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
    const key = canonicalHash(messages);
    const resultFile = join(dataDir, 'model-jobs', `${job.id}-${key}.result.json`);
    const load = () => this.loadBudget(job, path);
    const consent = () => this.jobConsent(job, signal);
    const assertCanTransmit = async () => {
      if (beforeSend) {
        await beforeSend();
        await consent();
      }
      signal.throwIfAborted();
    };
    type Call = Budget['calls'][string];
    const keptResult = async () => {
      const kept = await readJsonFile(resultFile, resultLimit);
      if (!kept) throw new Error('Completed result unavailable; inspect the receipt');
      return kept;
    };
    const settle = (call: Call, value: ReturnType<ModelTransport['receipt']>) =>
      modelLock(`${path}.lock`, async () => {
        const state = await load();
        const current = state.calls[key];
        if (!current || current.invocationId !== call.invocationId || current.quote !== call.quote)
          throw new Error('Model reservation changed; exposure remains reserved');
        if (current.completed) {
          if (current.actual !== value.actual) throw new Error('Conflicting invocation receipt');
          return keptResult();
        }
        state.charged = (
          BigInt(state.charged) -
          BigInt(call.quote) +
          BigInt(value.actual)
        ).toString();
        // Result first: a crash can retain an over-reservation, never erase exposure.
        await writePrivate(resultFile, JSON.stringify(value.result));
        state.calls[key] = { ...current, completed: true, actual: value.actual };
        await saveBudget(job.id, path, state);
        return value.result;
      });
    const existing = async (call: Call) => {
      if (call.completed) return keptResult();
      // Owner lookup is outside the lock and never creates another authorization.
      const recovered = await this.recover(call.invocationId, signal);
      if (recovered?.state === 'completed' && recovered.voucherState === 'accepted') {
        const value = this.receipt(
          recovered.result,
          call.invocationId,
          BigInt(call.quote),
          readable,
        );
        if (recovered.actualAtomic !== value.actual)
          throw new Error('Conflicting invocation receipt; exposure remains reserved');
        return settle(call, value);
      }
      throw new ModelCallFailed(
        `Uncertain invocation ${call.invocationId}; no new authorization sent`,
        { cause: 'failed' },
      );
    };
    const old = await modelLock(`${path}.lock`, async () => {
      await consent();
      return (await load()).calls[key];
    });
    step('budgetMs');
    if (old) return existing(old);
    // The request goes as the worker wrote it: nothing is masked by shape here (the worker's
    // own bridge and GitHub tokens are removed by value at the bridge, before this call).
    const body = {
      schemaVersion: 1,
      consent: true,
      jobId: job.decision.jobId,
      invocationId: randomUUID(),
      ...(stated !== undefined ? { maxResultBytes: stated } : {}),
      ...(relay ? { stream: true as const } : {}),
      messages,
    };
    const url = new URL(endpoint, baseUrl).toString();
    const fetchFn = payerDeps.fetchImpl ?? fetch;
    // THE CALL RATE. The router's offer names the wallet's rate and counts a call at this
    // unpaid quote, so the call waits here for room in the wallet's count. A WAIT PRECEDES
    // A SEND: after one, the request passes again every check it passed before it.
    const limit = advertisedCallLimit(job.decision);
    const paced = async () => {
      const waited = await this.pace.take(limit, signal);
      if (waited > 0) {
        timing.paceWaitMs = (timing.paceWaitMs ?? 0) + waited;
        await assertCanTransmit();
      }
    };
    // Nothing is reserved or signed yet, so a failure here leaves nothing uncertain.
    await assertCanTransmit();
    let wire = JSON.stringify(body);
    // AN OUTPUT CAP ABOVE 8,192 IS STEPPED DOWN TO WHAT THE JOB CAN STILL RESERVE, before
    // the quote is asked: the largest cap whose peak quote fits what is left of the job's
    // ceiling as it stands now. The call's identity stays the request as the worker made it.
    const sentMessages = 'messages' in body ? (body.messages as Record<string, unknown>) : null;
    const asked = sentMessages?.max_tokens;
    if (sentMessages && typeof asked === 'number' && asked > MODEL_OUTPUT_FLOOR_TOKENS) {
      const remaining = await modelLock(`${path}.lock`, async () => {
        const current = await consent();
        const cap = jobCap(current, job);
        return cap - BigInt((await load()).charged);
      });
      const fits = fittingOutputTokens(Buffer.byteLength(wire), asked, remaining);
      if (fits !== asked) {
        sentMessages.max_tokens = fits;
        wire = JSON.stringify(body);
      }
    }
    if (typeof sentMessages?.max_tokens === 'number') timing.outputCap = sentMessages.max_tokens;
    timing.requestBytes = Buffer.byteLength(wire);
    const now = this.options.paceClock?.now ?? Date.now;
    /** Provider events of this call's stream have reached the caller. */
    let relayed = false;
    /** The unpaid request: the router's quote for this call, and the amount it names. */
    const askQuote = async (): Promise<{ challenge: Response; amount: bigint }> => {
      const from = performance.now();
      await paced();
      // The wait is `paceWaitMs`, not the round trip's time.
      stepFrom += performance.now() - from;
      const challenge = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: wire,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }).catch((error: unknown) => {
        if (signal.aborted) throw error;
        // Nothing is reserved or paid yet: the router confirms nothing was charged.
        throw new ModelCallFailed(
          'Model proxy did not answer',
          { cause: timedOut(error) ? 'timeout' : 'failed', uncharged: true },
          { cause: error },
        );
      });
      if (challenge.status !== 402) {
        const wait = retryAfterMs(challenge.headers.get('retry-after'));
        // Its fixed code says what the router refused, such as `invalid_model_request`.
        const refused = await errorCode(boundedResponse(challenge, 65_536));
        await challenge.body?.cancel().catch(() => undefined);
        throw new ModelCallFailed('Model proxy did not return a payment quote', {
          cause: 'failed',
          status: challenge.status,
          uncharged: true,
          ...refused,
          ...(wait !== undefined ? { retryAfterMs: wait } : {}),
        });
      }
      const header = challenge.headers.get('payment-required');
      if (!header) {
        await challenge.body?.cancel();
        throw new Error('Model proxy has no quote');
      }
      const required = decodePaymentRequiredHeader(header);
      const offers = required.accepts.filter((r) => r.scheme === 'batch-settlement');
      if (offers.length !== 1 || !/^\d+$/.test(offers[0]!.amount)) {
        await challenge.body?.cancel();
        throw new Error('Unsupported model payment quote');
      }
      return { challenge, amount: BigInt(offers[0]!.amount) };
    };
    stepFrom = performance.now();
    const { challenge, amount: quote } = await askQuote();
    let quotedAt = now();
    step('quoteMs');
    let reservation: Call | undefined;
    try {
      reservation = await modelLock(`${path}.lock`, async () => {
        const current = await consent();
        const state = await load();
        if (state.calls[key]) return state.calls[key];
        const cap = jobCap(current, job);
        if (quote <= 0n || quote > cap - BigInt(state.charged))
          throw new ModelCallFailed('Model quote exceeds remaining job ceiling', {
            cause: 'budget',
          });
        const call = { invocationId: body.invocationId, quote: quote.toString() };
        state.calls[key] = call;
        state.charged = (BigInt(state.charged) + quote).toString();
        await saveBudget(job.id, path, state);
        return call;
      });
    } catch (error) {
      await challenge.body?.cancel();
      throw error;
    }
    step('reserveMs');
    if (reservation.invocationId !== body.invocationId) {
      await challenge.body?.cancel();
      return existing(reservation);
    }
    /** Records that this uncertain call needs the strict proof, for a later `reconcile`. */
    const markStrict = () =>
      modelLock(`${path}.lock`, async () => {
        const state = await load();
        const call = state.calls[key];
        if (call?.invocationId === body.invocationId && !call.completed && !call.strict) {
          state.calls[key] = { ...call, strict: true };
          await saveBudget(job.id, path, state);
        }
      }).catch(() => undefined);
    const release = () =>
      modelLock(`${path}.lock`, async () => {
        const state = await load();
        const call = state.calls[key];
        if (call?.invocationId === body.invocationId && !call.completed) {
          state.charged = (BigInt(state.charged) - BigInt(call.quote)).toString();
          delete state.calls[key];
          await saveBudget(job.id, path, state);
        }
      });
    /**
     * ONE TRY AT PAYING. What it leaves says how far it went: whether signing started,
     * whether a signed request reached fetch, and the router's answer to it.
     */
    type Paid = {
      result?: Awaited<ReturnType<ReturnType<Payer['routeFor']>['send']>>;
      failure?: unknown;
      signingStarted: boolean;
      paymentSent: boolean;
      localBlock?: LocalSendBlocked;
      paidError?: { status: number; code?: string };
      overCap?: QuoteOverCap;
      /** The fresh quote a long wait called for could not be had, or named another amount. */
      requote?: ModelCallFailed;
    };
    const payOn = async (): Promise<Paid> => {
      const paid: Paid = { signingStarted: false, paymentSent: false };
      let answer = quoted();
      let first = true;
      const cachedFetch: typeof fetch = async (input, init) => {
        if (first) {
          signal.throwIfAborted();
          first = false;
          return answer;
        }
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const signature = headers.get('payment-signature');
        const paying = signature !== null;
        try {
          await assertCanTransmit();
          if (signature !== null) {
            const from = performance.now();
            await journal.record(inferenceRun, url, signature, signal);
            timing.journalMs = (timing.journalMs ?? 0) + performance.now() - from;
            await assertCanTransmit();
          }
          signal.throwIfAborted();
          init?.signal?.throwIfAborted();
          // Events of a streamed reply have left: a second signed request is a second
          // charge for what the child has already been shown.
          if (paying && relayed) throw new Error('A second payment after a streamed reply');
        } catch (cause) {
          // httpRequest maps fetch failures to transport outcomes. Retain the
          // evidence that this invocation's authorization stayed local.
          paid.localBlock = new LocalSendBlocked(cause);
          throw paid.localBlock;
        }
        // A second signed request, or any unsigned one, is counted beside the first.
        if (!paying || paid.paymentSent) timing.fetches = (timing.fetches ?? 0) + 1;
        if (paying) {
          paid.paymentSent = true;
          step('signMs');
        }
        const callSignal = AbortSignal.any([...(init?.signal ? [init.signal] : []), signal]);
        // A paid call waits for its headers or its body as long as its own deadline and idle
        // limit say, not the 300 s Node's fetch allows (`paid-call-dispatcher.ts`).
        const sent = await fetchFn(input, {
          ...init,
          signal: callSignal,
          ...(paying && !payerDeps.fetchImpl
            ? {
                dispatcher: paidCallDispatcher(
                  paidCallTimeoutMs(job.decision),
                  streamIdleMs(job.decision),
                ),
              }
            : {}),
        } as RequestInit);
        // A reply that begins as a stream is read to its last event, which is the response
        // the whole answer would have been. A request that ended before any event answers as
        // a whole answer does (a refusal, an error, the stored JSON for a paid replay).
        const response =
          paying && relay && sent.status === 200 && sent.headers.get('tenjin-model-stream') === '1'
            ? await readMessagesStream(sent, {
                signal: callSignal,
                idleMs: streamIdleMs(job.decision),
                terminalBytes: resultLimit,
                contentBytes: readable,
                // The router's keep-alive reaches the child as the Messages API's own `ping`
                // event, so the child's idle limit is re-armed as the router's is.
                onKeep: () => {
                  if (!relayed) return;
                  try {
                    relay({ type: 'ping' });
                  } catch {
                    // What the child is shown never changes what is paid.
                  }
                },
                onEvent: (event) => {
                  const first = !relayed;
                  relayed = true;
                  // Time to the first event, from the signed request leaving.
                  if (first && timing.ttfbMs === undefined)
                    timing.ttfbMs = performance.now() - stepFrom;
                  try {
                    relay(event);
                  } catch {
                    // What the child is shown never changes what is paid.
                  }
                },
              })
            : boundedResponse(sent, resultLimit);
        if (paying) step('answerMs');
        // The router's answer to the signed request when it is an error: its status and
        // its fixed error code, read from a copy, never its message.
        if (paying && response.status >= 400)
          paid.paidError = { status: response.status, ...(await errorCode(response.clone())) };
        return response;
      };
      const payerOn = () =>
        new Payer({
          ...payerDeps,
          // A job's cap is the per-call limit or a lower named ceiling, so no deposit
          // passes the per-call limit. The rolling budget and creator gates are unchanged.
          policy: async () => {
            const policy = await payerDeps.policy();
            const current = await consent();
            const cap = jobCap(current, job);
            return {
              ...policy,
              maxAutoSpendAtomic: policy.maxAutoSpendAtomic < cap ? policy.maxAutoSpendAtomic : cap,
            };
          },
          getSigner: async () => {
            await assertCanTransmit();
            const signer = await payerDeps.getSigner();
            return {
              address: signer.address,
              signMessage: (args) => {
                paid.signingStarted = true;
                return signer.signMessage(args);
              },
              signTypedData: (args) => {
                paid.signingStarted = true;
                return signer.signTypedData(args);
              },
              signTransaction: (args) => {
                paid.signingStarted = true;
                return signer.signTransaction(args);
              },
            };
          },
          modelLane: {
            path: endpoint,
            ceilingAtomic: quote,
            origin: this.origin,
            inferenceRun,
          },
          fetchImpl: cachedFetch,
        });
      let paymentTurn = false;
      stepFrom = performance.now();
      try {
        paid.result = await withFileLock(
          channelLock,
          async () => {
            await beforeSend?.();
            // A CAP LOWERED WHILE THIS CALL WAITED FOR ITS CHANNEL still binds the job's
            // total: the payer's own check below reads this one quote alone. The quote was
            // reserved under the cap as it then stood, so what the job has reserved, this
            // call included, is held against the cap as it stands now. Over it, nothing is
            // signed and the reservation is released.
            const current = await consent();
            const cap = jobCap(current, job);
            if (BigInt((await load()).charged) > cap) throw (paid.overCap = new QuoteOverCap());
            // A QUOTE THE ROUTER NO LONGER HOLDS A PLACE FOR. A router that counts a call
            // at its quote serves the paid request that follows within 120 s whatever the
            // rate is by then; a later one it counts again, after the signature. This call
            // waited for the run's channel past that, so it asks for the quote again, with
            // the same invocation, before it signs. A fresh quote that cannot be had, or
            // that names another amount than the one reserved, ends this try unsigned and
            // uncharged, for the retry rule to take up with a new reservation.
            if (now() - quotedAt > QUOTE_FRESH_MS) {
              const from = performance.now();
              const fresh = await askQuote().catch((error: unknown) => {
                if (error instanceof ModelCallFailed) paid.requote = error;
                throw error;
              });
              if (fresh.amount !== quote) {
                await fresh.challenge.body?.cancel().catch(() => undefined);
                throw (paid.requote = new ModelCallFailed(
                  'Model quote changed while the call waited for its channel',
                  { cause: 'failed', uncharged: true },
                ));
              }
              await answer.body?.cancel().catch(() => undefined);
              quoted = () => fresh.challenge;
              answer = quoted();
              quotedAt = now();
              timing.requoteMs = (timing.requoteMs ?? 0) + performance.now() - from;
              stepFrom = performance.now();
            }
            signal.throwIfAborted();
            paymentTurn = true;
            step('gateMs');
            // The payer of the run's channel: it reads that channel's total, signs from
            // it and takes the router's answer into it, all under this lock.
            const payer = payerOn();
            try {
              const sent = await payer.routeFor(baseUrl).send(url, {
                method: 'POST',
                jsonBody: body,
                timeoutMs: paidCallTimeoutMs(job.decision),
                blockRedirects: true,
              });
              if (timing.answerMs !== undefined) step('bodyMs');
              return sent;
            } finally {
              // Hold the channel until SDK accounting drains, including detached work.
              const from = performance.now();
              await payer.idle();
              timing.drainMs = (timing.drainMs ?? 0) + performance.now() - from;
              stepFrom = performance.now();
            }
          },
          {
            signal,
            takeOverDead: true,
            // No job wall: the wait for the run's channel ends with the job's own signal, and
            // its holder is bounded by its own per-call deadline or is dead (taken over).
            timeoutMs: Number.POSITIVE_INFINITY,
            retryMs: 100,
          },
        );
      } catch (cause) {
        paid.failure = cause;
        if (!paymentTurn) paid.localBlock = new LocalSendBlocked(cause);
      } finally {
        if (first) await answer.body?.cancel().catch(() => undefined);
      }
      return paid;
    };
    // THE PAYMENT LOCK IS THE RUN'S CHANNEL'S, HELD FOR THE WHOLE PAID CALL. A voucher
    // signs the channel's charged total plus this quote. That total moves only when the
    // router's answer to the paid request is taken in, by what the router charged, which
    // may be less than the quote; and the router refuses a second payment on a channel
    // whose first is still in flight (`channel_busy`). So the next voucher of a channel
    // cannot be signed before the previous call's answer, and the lock covers the read of
    // the total, the signature, the paid request and its answer, across every process.
    // The run's own channel is locked alone, so no other job waits for it.
    const channelLock = join(
      dataDir,
      'model-jobs',
      `${modelInferenceRunScope(this.origin, inferenceRun).id}.payment.lock`,
    );
    let quoted = () => challenge;
    const paid = await payOn();
    const { result, failure, paymentSent, signingStarted, localBlock, paidError, overCap } = paid;
    if (failure !== undefined) {
      // A refusal before signing or a proven local guard failure can release
      // the quote only when no signed leg of this invocation reached fetch.
      if (!paymentSent && (localBlock || (failure instanceof RouteSkipped && !signingStarted))) {
        await release();
        if (overCap)
          throw new ModelCallFailed('Model quote exceeds remaining job ceiling', {
            cause: 'budget',
          });
        if (paid.requote) throw paid.requote;
        throw new ModelCallFailed(
          localBlock
            ? 'Model payment refused before transmission'
            : 'Model payment refused before signing; no authorization sent',
          {
            cause: 'payment_refused',
            ...(!localBlock && failure instanceof RouteSkipped ? { payer: failure.why } : {}),
          },
          { cause: localBlock ?? failure },
        );
      }
      // THE PROVIDER FAILED THE CALL: the router says so in a fixed code. Its own record
      // then says whether anything was charged; a call that cost nothing is released at
      // once, with the same read and rule as `reconcile`, and nothing is bought again.
      // A REPLY THE ROUTER CUT is released, and so may be tried again, only on its
      // stricter proof; a record that cannot be read, or one that does not hold that
      // proof, leaves the call uncertain and its reservation whole.
      if (paidError?.code !== undefined && PROVIDER_FAILURES.has(paidError.code)) {
        const server = await this.recover(body.invocationId, signal).catch(() => null);
        // After events reached the caller the call is released only on the strict proof, as a
        // cut reply is: a voucher cancelled together with a zero charge. A record that is
        // merely `unknown` and unaccepted stays uncertain, whatever the failure's code.
        const free =
          relayed || MODEL_CUT_REPLY_CODES.has(paidError.code) ? cutCostNothing : costNothing;
        if (server && free(server)) {
          await release();
          throw new ModelCallFailed(
            paidError.code === MODEL_REFUSED_CODE
              ? 'DeepSeek refused to answer this request, so the job ends here; nothing was charged for it'
              : 'The model provider failed the call; nothing was charged for it',
            { cause: 'provider', status: paidError.status, uncharged: true, code: paidError.code },
            { cause: failure },
          );
        }
      }
      // Left uncertain after events reached the caller, or after the router cut its reply:
      // a later `reconcile` releases it only on the same strict proof, never on the looser one.
      if (relayed || (paidError?.code !== undefined && MODEL_CUT_REPLY_CODES.has(paidError.code)))
        await markStrict();
      // The payer's own code says how far the paid call went, such as `payment_failed`
      // when the router answered the signed request with an error.
      throw new ModelCallFailed(
        `Model call uncertain (${body.invocationId}); recover its receipt before retrying`,
        {
          cause: timedOut(failure) ? 'timeout' : 'failed',
          ...(failure instanceof RouteSkipped ? { payer: failure.why } : {}),
          ...(paidError ? { status: paidError.status } : {}),
          ...(paidError?.code !== undefined ? { code: paidError.code } : {}),
        },
        { cause: failure },
      );
    }
    if (!result?.ok || result.status !== 200)
      throw new ModelCallFailed(
        'Model call uncertain; inspect invocation receipt before retrying',
        {
          cause: 'failed',
          ...(typeof result?.status === 'number' ? { status: result.status } : {}),
        },
      );
    stepFrom = performance.now();
    const settled = await settle(
      reservation,
      this.receipt(result.json, body.invocationId, quote, readable),
    );
    step('settleMs');
    return settled;
  }

  /** The job's budget as kept, or the routing fee alone for a job with no file yet. A job whose
   * budget this process has written or read never gets a fresh one: see {@link budgetsKept}. */
  private async loadBudget(job: ModelJob, path: string): Promise<Budget> {
    const parsed = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
    if (job.decision.requireExistingBudget === true && !parsed.success)
      throw new Error('Original model budget is unavailable; refusing continuation');
    if (!parsed.success && (await lstat(path).catch(() => null)))
      throw new Error('Unreadable model budget; refusing another authorization');
    // FAIL CLOSED: a run that has started never reads a missing file as a fresh budget (it
    // would hold the routing fee alone and let a job spend its cap again). Nothing is signed.
    if (!parsed.success && budgetsKept.has(job.id))
      throw new Error('Model budget is missing for a running job; refusing another authorization');
    if (parsed.success) budgetsKept.add(job.id);
    return parsed.success ? parsed.data : { charged: routingExposure(job).toString(), calls: {} };
  }

  /** The consent the job runs under, still in force for this router. */
  private async jobConsent(job: ModelJob, signal?: AbortSignal) {
    const current = await modelSettings(this.options.dataDir, job.root);
    signal?.throwIfAborted();
    if (!current || current.routerOrigin !== this.origin)
      throw new Error('Model consent revoked or origin changed');
    return current;
  }

  /**
   * A ROUTER TOOL A WORKER'S NATIVE TOOL PAID FOR (its failed WebFetch's page read through Exa), counted in
   * the job's budget beside its model calls, so the job's spend, its end line and every
   * later model quote see it. Reserved at the tool's price ceiling before anything is
   * signed: a call that would pass the job's cap is refused here, unpaid. `run` pays from
   * the person's wallet within their own limits and says what their spend gate committed,
   * and whether a payment may have left that it could not account. Settled at what was
   * committed; a call that signed nothing releases its reservation, and an uncertain one
   * keeps it whole, as an uncertain model call does.
   */
  async toolCall<T>(
    job: ModelJob,
    tool: string,
    ceilingAtomic: bigint,
    run: () => Promise<{ value: T; spentAtomic: bigint; uncertain: boolean }>,
  ): Promise<T> {
    const { dataDir } = this.options;
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
    const key = `tool:${randomUUID()}`;
    const call = { invocationId: randomUUID(), quote: ceilingAtomic.toString(), tool };
    await modelLock(`${path}.lock`, async () => {
      const current = await this.jobConsent(job);
      const state = await this.loadBudget(job, path);
      const cap = jobCap(current, job);
      if (ceilingAtomic <= 0n || ceilingAtomic > cap - BigInt(state.charged))
        throw new ModelCallFailed('Tool price exceeds remaining job ceiling', { cause: 'budget' });
      state.calls[key] = call;
      state.charged = (BigInt(state.charged) + ceilingAtomic).toString();
      await saveBudget(job.id, path, state);
    });
    // A throw here keeps the whole reservation: nothing says what was signed.
    const ran = await run();
    if (!ran.uncertain)
      await modelLock(`${path}.lock`, async () => {
        const state = await this.loadBudget(job, path);
        const now = state.calls[key];
        if (now?.invocationId !== call.invocationId || now.completed) return;
        state.charged = (BigInt(state.charged) - ceilingAtomic + ran.spentAtomic).toString();
        if (ran.spentAtomic === 0n) delete state.calls[key];
        else state.calls[key] = { ...now, completed: true, actual: ran.spentAtomic.toString() };
        await saveBudget(job.id, path, state);
      });
    return ran.value;
  }

  private receipt(raw: unknown, invocationId: string, quote: bigint, messageBytes: number) {
    const value = z
      .object({
        message: z
          .record(z.string(), z.unknown())
          .refine((message) => Buffer.byteLength(JSON.stringify(message)) <= messageBytes),
        receipt: z.object({
          invocationId: z.literal(invocationId),
          quoteAtomic: z.literal(quote.toString()),
          actualAtomic: z.string().regex(/^\d+$/),
        }),
      })
      .safeParse(raw);
    if (!value.success || BigInt(value.data.receipt.actualAtomic) > quote)
      throw new Error('Invalid model receipt; exposure remains reserved');
    return {
      result: value.data.message,
      actual: value.data.receipt.actualAtomic,
    };
  }

  private async recover(invocationId: string, signal: AbortSignal) {
    const { payerDeps, baseUrl } = this.options;
    const signer = await payerDeps.getSigner();
    const auth = await buildSiwxHeader(signer, { baseUrl, chainId: SIWX_CHAIN_ID, ttlMs: 300_000 });
    const response = await (payerDeps.fetchImpl ?? fetch)(
      new URL(`/api/model-proxy/messages/${invocationId}`, baseUrl),
      {
        headers: { [SIWX_HEADER]: auth },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = await boundedJson(response);
    const parsed = z
      .object({
        invocationId: z.literal(invocationId),
        state: z.string(),
        voucherState: z.string(),
        actualAtomic: z.string().regex(/^\d+$/),
        result: z.unknown(),
      })
      .safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Checks each reservation an ended run left uncertain against the server's
   * own record of it: one owner-authenticated read per call, which buys
   * nothing. A call the server finished with an accepted voucher is recorded
   * at its actual cost. A call it failed with no accepted voucher, or whose
   * voucher it cancelled, cost nothing and is released. Any other answer, or
   * none, keeps the full reservation. Only for a job with no run going: a call
   * in flight is uncertain by design. Never throws.
   */
  async reconcile(job: ModelJob, signal: AbortSignal): Promise<void> {
    try {
      const { dataDir } = this.options;
      const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
      const current = await modelSettings(dataDir, job.root);
      // The read names the job's calls to its own router only, under consent still in force.
      if (current?.routerOrigin !== this.origin || job.decision.routerOrigin !== this.origin)
        return;
      const kept = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
      if (!kept.success) return;
      for (const [key, call] of Object.entries(kept.data.calls)) {
        // A tool call's id is local: the model proxy has no record of it to read.
        if (call.completed || call.tool !== undefined) continue;
        const server = await this.recover(call.invocationId, signal).catch(() => null);
        if (!server) continue;
        const spent = server.state === 'completed' && server.voucherState === 'accepted';
        // A call whose events reached its caller, or whose reply the router cut, needs the
        // strict proof here as at the call.
        const free = call.strict === true ? cutCostNothing(server) : costNothing(server);
        if (!spent && !free) continue;
        const actual = spent ? BigInt(server.actualAtomic) : 0n;
        await modelLock(`${path}.lock`, async () => {
          const state = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
          const now = state.success ? state.data.calls[key] : undefined;
          if (!state.success || !now || now.completed || now.invocationId !== call.invocationId)
            return;
          if (actual > BigInt(now.quote)) return;
          state.data.charged = (BigInt(state.data.charged) - BigInt(now.quote) + actual).toString();
          // A released call leaves no entry, so the same request can be bought again.
          if (spent) state.data.calls[key] = { ...now, completed: true, actual: actual.toString() };
          else delete state.data.calls[key];
          await saveBudget(job.id, path, state.data);
        });
      }
    } catch {
      // Whatever could not be read stays reserved.
    }
    await this.closeRefundOfSettled(job).catch(() => undefined);
  }

  /**
   * THE REFUND OF A RUN WHOSE LAST UNCERTAIN CALL IS SETTLED. A run cancelled with a call
   * still in flight closed its channel at once and may have been refused or left pending; the
   * call is settled only here, so the refund is tried again here rather than only when a
   * recovery pass comes round. A channel with a call still uncertain is not closed.
   */
  private async closeRefundOfSettled(job: ModelJob) {
    const spend = await this.summary(job).catch(() => undefined);
    if (!spend || spend.uncertain.length > 0) return;
    await this.refundJournal().close(job.id, AbortSignal.timeout(8_000));
  }

  /** Actual completed usage plus conservative reservations for uncertain calls. */
  async summary(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    const parsed = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
    const routing = routingExposure(job).toString();
    if (!parsed.success && (await lstat(path).catch(() => null)))
      throw new Error('Model accounting is unreadable; exposure is unknown');
    if (!parsed.success)
      return { reservedAtomic: routing, actualAtomic: routing, uncertain: [] as string[] };
    const calls = Object.values(parsed.data.calls);
    return {
      reservedAtomic: parsed.data.charged,
      actualAtomic: (
        BigInt(routing) + calls.reduce((sum, call) => sum + BigInt(call.actual ?? '0'), 0n)
      ).toString(),
      uncertain: calls.filter((call) => !call.completed).map((call) => call.invocationId),
    };
  }
}
