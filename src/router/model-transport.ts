import { lstat, mkdir } from 'node:fs/promises';
import { mask } from '../lib/redact';
import { modelSettings } from './model-settings';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { withFileLock } from '../lib/lock';
import type { RoutingPayerDeps } from './routing-payer';
import { RoutingPayer as Payer } from './routing-payer';
import { readJsonFile, writePrivate } from './store-files';
import { canonicalHash } from '../lib/request-schema';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import { z } from 'zod';
import type { ModelJob } from './model-job';
import { MODEL_ROUTING_FEE_CEILING_ATOMIC } from './model-channel';
import { RouteSkipped } from './decision';

const budgetSchema = z.object({
  charged: z.string().regex(/^\d+$/),
  calls: z.record(
    z.string(),
    z.object({
      invocationId: z.uuid(),
      quote: z.string().regex(/^\d+$/),
      completed: z.boolean().optional(),
      actual: z.string().regex(/^\d+$/).optional(),
    }),
  ),
});
type Budget = z.infer<typeof budgetSchema>;

/** A bounded read is required even on our own server: provider messages are untrusted. */
async function boundedJson(response: Response, limit = 2_100_000): Promise<unknown> {
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

function boundedResponse(response: Response, limit = 2_100_000): Response {
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
  constructor(
    private options: {
      dataDir: string;
      baseUrl: string;
      payerDeps: RoutingPayerDeps;
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
  /** A continuation must retain every old charge and uncertain reservation. */
  async requireResumeBudget(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    await withFileLock(`${path}.lock`, async () => {
      if (!budgetSchema.safeParse(await readJsonFile(path, 1_000_000)).success)
        throw new Error('Original model budget is unavailable; refusing continuation');
    });
  }
  async route(body: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const route = this.routing.routeFor(this.options.baseUrl);
    let result;
    try {
      const fetchFn = this.options.payerDeps.fetchImpl ?? fetch;
      const guardedFetch: typeof fetch = async (input, init) => {
        signal?.throwIfAborted();
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
          ...(signal ? { fetchImpl: guardedFetch } : {}),
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
  async messages(job: ModelJob, messages: Record<string, unknown>, signal: AbortSignal) {
    return this.invoke(job, messages, signal, 'messages');
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
  ) {
    signal.throwIfAborted();
    const endpoint =
      protocol === 'responses' ? '/api/model-proxy/responses' : '/api/model-proxy/messages';
    const resultLimit = protocol === 'responses' ? 64 * 1024 * 1024 : 2_100_000;
    const { dataDir, baseUrl, payerDeps } = this.options;
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
    const key =
      protocol === 'responses'
        ? canonicalHash({ protocol, responses: messages })
        : canonicalHash(messages);
    const resultFile = join(dataDir, 'model-jobs', `${job.id}-${key}.result.json`);
    const load = async (): Promise<Budget> => {
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
    };
    const consent = async () => {
      const current = await modelSettings(dataDir, job.root);
      signal.throwIfAborted();
      if (!current || current.routerOrigin !== new URL(baseUrl).origin)
        throw new Error('Model consent revoked or origin changed');
      return current;
    };
    type Call = Budget['calls'][string];
    const keptResult = async () => {
      const kept = await readJsonFile(resultFile, resultLimit);
      if (!kept) throw new Error('Completed result unavailable; inspect the receipt');
      return kept;
    };
    const settle = (call: Call, value: ReturnType<ModelTransport['receipt']>) =>
      withFileLock(`${path}.lock`, async () => {
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
      throw new Error(`Uncertain invocation ${call.invocationId}; no new authorization sent`);
    };
    const old = await withFileLock(`${path}.lock`, async () => {
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
    const challenge = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (challenge.status !== 402) {
      await challenge.body?.cancel();
      throw new Error('Model proxy did not return a payment quote');
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
      reservation = await withFileLock(`${path}.lock`, async () => {
        const current = await consent();
        const state = await load();
        if (state.calls[key]) return state.calls[key];
        const cap =
          current.maxJobAtomic < BigInt(job.capAtomic)
            ? current.maxJobAtomic
            : BigInt(job.capAtomic);
        if (quote <= 0n || quote > cap - BigInt(state.charged))
          throw new Error('Model quote exceeds remaining job ceiling');
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
    let signingStarted = false;
    let paymentSent = false;
    let first = true;
    const cachedFetch: typeof fetch = async (input, init) => {
      signal.throwIfAborted();
      if (first) {
        first = false;
        return challenge;
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (headers.has('payment-signature')) paymentSent = true;
      return boundedResponse(
        await fetchFn(input, {
          ...init,
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), signal]),
        }),
        resultLimit,
      );
    };
    const payer = new Payer({
      ...payerDeps,
      getSigner: async () => {
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
      modelLane: { path: endpoint, ceilingAtomic: quote, origin: this.origin },
      fetchImpl: cachedFetch,
    });
    let result;
    let failure: unknown;
    try {
      result = await payer
        .routeFor(baseUrl)
        .send(url, { method: 'POST', jsonBody: body, timeoutMs: 360_000, blockRedirects: true });
    } catch (cause) {
      failure = cause;
    } finally {
      // Drain SDK accounting before either releasing or reporting uncertainty.
      await payer.idle();
    }
    if (failure !== undefined) {
      // RouteSkipped alone does not prove safety: it can also follow a signed send.
      // Only a refusal with neither signing nor transmission can release exposure.
      if (failure instanceof RouteSkipped && !signingStarted && !paymentSent) {
        await withFileLock(`${path}.lock`, async () => {
          const state = await load();
          const call = state.calls[key];
          if (call?.invocationId === body.invocationId && !call.completed) {
            state.charged = (BigInt(state.charged) - BigInt(call.quote)).toString();
            delete state.calls[key];
            await writePrivate(path, JSON.stringify(state));
          }
        });
        throw new Error('Model payment refused before signing; no authorization sent', {
          cause: failure,
        });
      }
      throw new Error(
        `Model call uncertain (${body.invocationId}); recover its receipt before retrying`,
        { cause: failure },
      );
    }
    if (!result?.ok || result.status !== 200)
      throw new Error('Model call uncertain; inspect invocation receipt before retrying');
    return settle(reservation, this.receipt(result.json, body.invocationId, quote, protocol));
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
          ? { wire: z.string().refine((wire) => Buffer.byteLength(wire) <= 32 * 1024 * 1024) }
          : { message: z.record(z.string(), z.unknown()) }),
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
    const value = await boundedJson(
      response,
      protocol === 'responses' ? 64 * 1024 * 1024 : 2_100_000,
    );
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
