import { lstat, mkdir } from 'node:fs/promises';
import { mask } from '../lib/redact';
import { modelSettings } from './model-settings';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RoutingPayerDeps } from './routing-payer';
import { LocalSendBlocked, RoutingPayer as Payer } from './routing-payer';
import { readJsonFile, writePrivate } from './store-files';
import { canonicalHash } from '../lib/request-schema';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import { z } from 'zod';
import { modelLock, type ModelJob } from './model-job';
import {
  MODEL_ROUTING_FEE_CEILING_ATOMIC,
  modelChannelScope,
  type ModelInferenceSlot,
} from './model-channel';
import { withFileLock } from '../lib/lock';
import { RouteSkipped } from './decision';
import {
  MODEL_MESSAGES_RESULT_BYTES,
  MODEL_RESPONSE_ENVELOPE_BYTES,
  MODEL_RESPONSES_WIRE_BYTES,
} from './model-limits';
import { ModelCallFailed, retryAfterMs, timedOut, WORKER_WALL_MS } from './model-worker-control';

/**
 * The router's codes for a paid model call the provider failed (its `model_inference_failed`,
 * `incomplete_model_response` and `model_response_too_large`): it marks that call's record
 * with no charge and settles nothing on the error answer.
 */
const PROVIDER_FAILURES = new Set([
  'model_inference_failed',
  'incomplete_model_response',
  'model_response_too_large',
]);

/** An error answer's fixed code (`{error: {code}}`), never its message. */
async function errorCode(response: Response): Promise<{ code?: string }> {
  try {
    const code = ((await response.json()) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? { code } : {};
  } catch {
    return {};
  }
}

/** The router's record says a call cost nothing: its voucher cancelled, or it failed unpaid. */
function costNothing(server: { state: string; voucherState: string }): boolean {
  return (
    server.voucherState === 'cancelled' ||
    (server.state === 'unknown' && server.voucherState !== 'accepted')
  );
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

/** Job ceiling survives process death. Reserve before sending, retain uncertainty. */
export class ModelTransport {
  private routing: Payer;
  /** Local waiters only. The persisted reservation remains authoritative across transports. */
  private readonly invocations = new Map<string, InFlightInvocation>();
  constructor(
    private options: {
      dataDir: string;
      baseUrl: string;
      payerDeps: RoutingPayerDeps;
      inferenceSlot?: ModelInferenceSlot;
    },
  ) {
    this.routing = new Payer({
      ...options.payerDeps,
      modelLane: {
        path: '/api/model-router/route',
        ceilingAtomic: MODEL_ROUTING_FEE_CEILING_ATOMIC,
        origin: this.origin,
      },
    });
  }
  get origin() {
    return new URL(this.options.baseUrl).origin;
  }
  forInferenceSlot(inferenceSlot: ModelInferenceSlot): ModelTransport {
    return (this.options.inferenceSlot ?? 0) === inferenceSlot
      ? this
      : new ModelTransport({ ...this.options, inferenceSlot });
  }
  /** A continuation must retain every old charge and uncertain reservation. */
  async requireResumeBudget(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    await modelLock(`${path}.lock`, async () => {
      if (!budgetSchema.safeParse(await readJsonFile(path, 1_000_000)).success)
        throw new Error('Original model budget is unavailable; refusing continuation');
    });
  }
  async route(body: unknown, signal?: AbortSignal, beforeSend?: () => Promise<void>) {
    signal?.throwIfAborted();
    const route = this.routing.routeFor(this.options.baseUrl);
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
        return fetchFn(input, {
          ...init,
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
      };
      result = await route.send(
        new URL('/api/model-router/route', this.options.baseUrl).toString(),
        {
          method: 'POST',
          jsonBody: body,
          timeoutMs: 5000,
          blockRedirects: true,
          ...(signal || beforeSend ? { fetchImpl: guardedFetch } : {}),
        },
      );
      signal?.throwIfAborted();
    } finally {
      // Lifecycle fences wait until any already signed accounting is drained.
      await this.routing.idle();
    }
    if (!result.ok || result.status !== 200)
      throw new Error('Model router unavailable; keep native');
    return result.json;
  }
  async messages(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
  ) {
    return this.invoke(job, messages, signal, 'messages', beforeSend);
  }
  async responses(
    job: ModelJob,
    responses: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.invoke(job, responses, signal, 'responses');
    if (typeof result.wire !== 'string') throw new Error('Responses wire is unavailable');
    return result.wire;
  }
  private async invoke(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    protocol: 'messages' | 'responses',
    beforeSend?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    // Do not share across changed job authority, even when the provider body is identical.
    const key = canonicalHash({ job, protocol, messages });
    let invocation = this.invocations.get(key);
    if (!invocation) {
      const abort = new AbortController();
      const result = this.invokeOnce(
        structuredClone(job),
        structuredClone(messages),
        abort.signal,
        protocol,
        beforeSend,
      ).finally(() => {
        if (this.invocations.get(key)?.abort === abort) this.invocations.delete(key);
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
  private async invokeOnce(
    job: ModelJob,
    messages: Record<string, unknown>,
    signal: AbortSignal,
    protocol: 'messages' | 'responses',
    beforeSend?: () => Promise<void>,
  ) {
    signal.throwIfAborted();
    const endpoint =
      protocol === 'responses' ? '/api/model-proxy/responses' : '/api/model-proxy/messages';
    const resultLimit = MODEL_RESPONSE_ENVELOPE_BYTES;
    const { dataDir, baseUrl, payerDeps } = this.options;
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
    const key =
      protocol === 'responses'
        ? canonicalHash({ protocol, responses: messages })
        : canonicalHash(messages);
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
        await writePrivate(path, JSON.stringify(state));
        return value.result;
      });
    const existing = async (call: Call) => {
      if (call.completed) return keptResult();
      // Owner lookup is outside the lock and never creates another authorization.
      const recovered = await this.recover(call.invocationId, signal, protocol);
      if (recovered?.state === 'completed' && recovered.voucherState === 'accepted') {
        const value = this.receipt(
          recovered.result,
          call.invocationId,
          BigInt(call.quote),
          protocol,
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
    if (old) return existing(old);
    const scrub = (value: unknown, field = ''): unknown => {
      if (protocol === 'responses' && ['parameters', 'input_schema', 'format'].includes(field))
        return value;
      if (typeof value === 'string')
        return (protocol === 'responses'
          ? [
              'signature',
              'encrypted_content',
              'id',
              'call_id',
              'tool_call_id',
              'item_id',
              'tool_use_id',
              'name',
              'namespace',
              'type',
              'model',
              'role',
            ]
          : ['signature', 'id', 'tool_use_id', 'name', 'type', 'model', 'role']
        ).includes(field)
          ? value
          : mask(value);
      if (Array.isArray(value)) return value.map((v) => scrub(v, field));
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
      return value;
    };
    const body = {
      schemaVersion: 1,
      consent: true,
      jobId: job.decision.jobId,
      invocationId: randomUUID(),
      ...(protocol === 'responses'
        ? { protocol, responses: scrub(messages) }
        : { messages: scrub(messages) }),
    };
    const url = new URL(endpoint, baseUrl).toString();
    const fetchFn = payerDeps.fetchImpl ?? fetch;
    // Nothing is reserved or signed yet, so a failure here leaves nothing uncertain.
    await assertCanTransmit();
    const challenge = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
      await challenge.body?.cancel();
      const wait = retryAfterMs(challenge.headers.get('retry-after'));
      throw new ModelCallFailed('Model proxy did not return a payment quote', {
        cause: 'failed',
        status: challenge.status,
        uncharged: true,
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
    const quote = BigInt(offers[0]!.amount);
    let reservation: Call | undefined;
    try {
      reservation = await modelLock(`${path}.lock`, async () => {
        const current = await consent();
        const state = await load();
        if (state.calls[key]) return state.calls[key];
        const cap =
          current.maxJobAtomic < BigInt(job.capAtomic)
            ? current.maxJobAtomic
            : BigInt(job.capAtomic);
        if (quote <= 0n || quote > cap - BigInt(state.charged))
          throw new ModelCallFailed('Model quote exceeds remaining job ceiling', {
            cause: 'budget',
          });
        const call = { invocationId: body.invocationId, quote: quote.toString() };
        state.calls[key] = call;
        state.charged = (BigInt(state.charged) + quote).toString();
        await writePrivate(path, JSON.stringify(state));
        return call;
      });
    } catch (error) {
      await challenge.body?.cancel();
      throw error;
    }
    if (reservation.invocationId !== body.invocationId) {
      await challenge.body?.cancel();
      return existing(reservation);
    }
    const release = () =>
      modelLock(`${path}.lock`, async () => {
        const state = await load();
        const call = state.calls[key];
        if (call?.invocationId === body.invocationId && !call.completed) {
          state.charged = (BigInt(state.charged) - BigInt(call.quote)).toString();
          delete state.calls[key];
          await writePrivate(path, JSON.stringify(state));
        }
      });
    let signingStarted = false;
    let paymentSent = false;
    let localBlock: LocalSendBlocked | undefined;
    let paidError: { status: number; code?: string } | undefined;
    let first = true;
    const cachedFetch: typeof fetch = async (input, init) => {
      if (first) {
        signal.throwIfAborted();
        first = false;
        return challenge;
      }
      try {
        await assertCanTransmit();
        signal.throwIfAborted();
        init?.signal?.throwIfAborted();
      } catch (cause) {
        // httpRequest maps fetch failures to transport outcomes. Retain the
        // evidence that this invocation's authorization stayed local.
        localBlock = new LocalSendBlocked(cause);
        throw localBlock;
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const paying = headers.has('payment-signature');
      if (paying) paymentSent = true;
      const response = boundedResponse(
        await fetchFn(input, {
          ...init,
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), signal]),
        }),
        resultLimit,
      );
      // The router's answer to the signed request when it is an error: its status and
      // its fixed error code, read from a copy, never its message.
      if (paying && response.status >= 400)
        paidError = { status: response.status, ...(await errorCode(response.clone())) };
      return response;
    };
    const payer = new Payer({
      ...payerDeps,
      // Inference has a separately accepted job ceiling. Keep the rolling
      // budget/creator gates and an explicit automatic-spend stop unchanged.
      policy: async () => {
        const policy = await payerDeps.policy();
        const current = await consent();
        return {
          ...policy,
          maxAutoSpendAtomic:
            policy.maxAutoSpendAtomic === 0n
              ? 0n
              : current.maxJobAtomic < BigInt(job.capAtomic)
                ? current.maxJobAtomic
                : BigInt(job.capAtomic),
        };
      },
      getSigner: async () => {
        await assertCanTransmit();
        const signer = await payerDeps.getSigner();
        return {
          address: signer.address,
          signMessage: (args) => {
            signingStarted = true;
            return signer.signMessage(args);
          },
          signTypedData: (args) => {
            signingStarted = true;
            return signer.signTypedData(args);
          },
          signTransaction: (args) => {
            signingStarted = true;
            return signer.signTransaction(args);
          },
        };
      },
      modelLane: {
        path: endpoint,
        ceilingAtomic: quote,
        origin: this.origin,
        inferenceSlot: this.options.inferenceSlot,
      },
      fetchImpl: cachedFetch,
    });
    // The model endpoints share the same two inference channels. Take turns
    // within each channel across local transports and processes.
    const scope = modelChannelScope(this.origin, 'model-inference', this.options.inferenceSlot);
    const paymentLock = join(dataDir, 'model-jobs', `${scope.id}.payment.lock`);
    let paymentTurn = false;
    let result;
    let failure: unknown;
    try {
      result = await withFileLock(
        paymentLock,
        async () => {
          await beforeSend?.();
          await consent();
          signal.throwIfAborted();
          paymentTurn = true;
          try {
            return await payer.routeFor(baseUrl).send(url, {
              method: 'POST',
              jsonBody: body,
              timeoutMs: 360_000,
              blockRedirects: true,
            });
          } finally {
            // Hold the channel until SDK accounting drains, including detached work.
            await payer.idle();
          }
        },
        { signal, takeOverDead: true, timeoutMs: WORKER_WALL_MS, retryMs: 100 },
      );
    } catch (cause) {
      failure = cause;
      if (!paymentTurn) localBlock = new LocalSendBlocked(cause);
    } finally {
      if (first) await challenge.body?.cancel().catch(() => undefined);
    }
    if (failure !== undefined) {
      // A refusal before signing or a proven local guard failure can release
      // the quote only when no signed leg of this invocation reached fetch.
      if (!paymentSent && (localBlock || (failure instanceof RouteSkipped && !signingStarted))) {
        await release();
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
      if (paidError?.code !== undefined && PROVIDER_FAILURES.has(paidError.code)) {
        const server = await this.recover(body.invocationId, signal, protocol).catch(() => null);
        if (server && costNothing(server)) {
          await release();
          throw new ModelCallFailed(
            'The model provider failed the call; nothing was charged for it',
            { cause: 'provider', status: paidError.status, uncharged: true },
            { cause: failure },
          );
        }
      }
      // The payer's own code says how far the paid call went, such as `payment_failed`
      // when the router answered the signed request with an error.
      throw new ModelCallFailed(
        `Model call uncertain (${body.invocationId}); recover its receipt before retrying`,
        {
          cause: timedOut(failure) ? 'timeout' : 'failed',
          ...(failure instanceof RouteSkipped ? { payer: failure.why } : {}),
          ...(paidError ? { status: paidError.status } : {}),
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
    return settle(reservation, this.receipt(result.json, body.invocationId, quote, protocol));
  }

  /** The job's budget as kept, or the routing fee alone for a job with no file yet. */
  private async loadBudget(job: ModelJob, path: string): Promise<Budget> {
    const parsed = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
    if (job.decision.requireExistingBudget === true && !parsed.success)
      throw new Error('Original model budget is unavailable; refusing continuation');
    if (!parsed.success && (await lstat(path).catch(() => null)))
      throw new Error('Unreadable model budget; refusing another authorization');
    // The route's payment ceiling is trusted locally; an offer cannot reduce it.
    return parsed.success
      ? parsed.data
      : {
          charged: MODEL_ROUTING_FEE_CEILING_ATOMIC.toString(),
          calls: {},
        };
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
   * A ROUTER TOOL A WORKER'S NATIVE TOOL PAID FOR (its web search through Exa), counted in
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
      const cap =
        current.maxJobAtomic < BigInt(job.capAtomic) ? current.maxJobAtomic : BigInt(job.capAtomic);
      if (ceilingAtomic <= 0n || ceilingAtomic > cap - BigInt(state.charged))
        throw new ModelCallFailed('Tool price exceeds remaining job ceiling', { cause: 'budget' });
      state.calls[key] = call;
      state.charged = (BigInt(state.charged) + ceilingAtomic).toString();
      await writePrivate(path, JSON.stringify(state));
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
        await writePrivate(path, JSON.stringify(state));
      });
    return ran.value;
  }

  private receipt(
    raw: unknown,
    invocationId: string,
    quote: bigint,
    protocol: 'messages' | 'responses',
  ) {
    const value = z
      .object({
        ...(protocol === 'responses'
          ? {
              wire: z
                .string()
                .refine((wire) => Buffer.byteLength(wire) <= MODEL_RESPONSES_WIRE_BYTES),
            }
          : {
              message: z
                .record(z.string(), z.unknown())
                .refine(
                  (message) =>
                    Buffer.byteLength(JSON.stringify(message)) <= MODEL_MESSAGES_RESULT_BYTES,
                ),
            }),
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
      result: 'wire' in value.data ? { wire: value.data.wire } : value.data.message,
      actual: value.data.receipt.actualAtomic,
    };
  }

  private async recover(
    invocationId: string,
    signal: AbortSignal,
    protocol: 'messages' | 'responses',
  ) {
    const { payerDeps, baseUrl } = this.options;
    const signer = await payerDeps.getSigner();
    const auth = await buildSiwxHeader(signer, { baseUrl, chainId: SIWX_CHAIN_ID, ttlMs: 300_000 });
    const response = await (payerDeps.fetchImpl ?? fetch)(
      new URL(`/api/model-proxy/${protocol}/${invocationId}`, baseUrl),
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
  async reconcile(
    job: ModelJob,
    signal: AbortSignal,
    protocol: 'messages' | 'responses' = 'messages',
  ): Promise<void> {
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
        const server = await this.recover(call.invocationId, signal, protocol).catch(() => null);
        if (!server) continue;
        const spent = server.state === 'completed' && server.voucherState === 'accepted';
        const free = costNothing(server);
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
          await writePrivate(path, JSON.stringify(state.data));
        });
      }
    } catch {
      // Whatever could not be read stays reserved.
    }
  }

  /** Actual completed usage plus conservative reservations for uncertain calls. */
  async summary(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    const parsed = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
    const routing = MODEL_ROUTING_FEE_CEILING_ATOMIC.toString();
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
