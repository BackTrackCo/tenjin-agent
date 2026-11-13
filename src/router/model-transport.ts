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
import { ROUTING_FEE_CEILING_ATOMIC } from './fee';

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
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty invocation receipt');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_100_000) throw new Error('Invocation receipt exceeds size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function boundedResponse(response: Response): Response {
  if (!response.body) return response;
  let size = 0;
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > 2_100_000) throw new Error('Model response exceeds size limit');
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
        ceilingAtomic: ROUTING_FEE_CEILING_ATOMIC,
        origin: this.origin,
      },
    });
  }
  get origin() {
    return new URL(this.options.baseUrl).origin;
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
    const { dataDir, baseUrl, payerDeps } = this.options;
    await mkdir(join(dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'model-jobs', `${job.id}.budget.json`);
    return withFileLock(`${path}.lock`, async () => {
      const raw = await readJsonFile(path, 1_000_000);
      const parsed = budgetSchema.safeParse(raw);
      if (!parsed.success && (await lstat(path).catch(() => null)))
        throw new Error('Unreadable model budget; refusing another authorization');
      const current = await modelSettings(dataDir, job.root);
      if (!current || current.routerOrigin !== new URL(baseUrl).origin)
        throw new Error('Model consent revoked or origin changed');
      const state: Budget = parsed.success
        ? parsed.data
        : {
            charged: String(job.decision.routingFeeAtomic ?? '3000'),
            calls: {},
          };
      const calls = state.calls;
      const key = canonicalHash(messages);
      const old = calls[key];
      const resultFile = join(dataDir, 'model-jobs', `${job.id}-${key}.result.json`);
      if (old?.completed) {
        const kept = await readJsonFile(resultFile, 2_100_000);
        if (!kept) throw new Error('Completed result unavailable; inspect the receipt');
        return kept;
      }
      if (old) {
        // Recovery never creates a new voucher or calls the provider again.
        const recovered = await this.recover(old.invocationId, signal);
        if (recovered?.state === 'completed' && recovered.voucherState === 'accepted') {
          const value = this.receipt(recovered.result, old.invocationId, BigInt(old.quote));
          if (recovered.actualAtomic !== value.actual)
            throw new Error('Conflicting invocation receipt; exposure remains reserved');
          state.charged = (
            BigInt(state.charged) -
            BigInt(old.quote) +
            BigInt(value.actual)
          ).toString();
          await writePrivate(resultFile, JSON.stringify(value.message));
          calls[key] = { ...old, completed: true, actual: value.actual };
          await writePrivate(path, JSON.stringify(state));
          return value.message;
        }
        throw new Error(`Uncertain invocation ${old.invocationId}; no new authorization sent`);
      }
      const scrub = (value: unknown, field = ''): unknown => {
        if (typeof value === 'string')
          return ['signature', 'id', 'tool_use_id', 'name', 'type', 'model', 'role'].includes(field)
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
        messages: scrub(messages),
      };
      const url = new URL('/api/model-proxy/messages', baseUrl).toString();
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
      const cap =
        current.maxJobAtomic < BigInt(job.capAtomic) ? current.maxJobAtomic : BigInt(job.capAtomic);
      const remaining = cap - BigInt(String(state.charged));
      if (quote <= 0n || quote > remaining) {
        await challenge.body?.cancel();
        throw new Error('Model quote exceeds remaining job ceiling');
      }
      calls[key] = { invocationId: body.invocationId, quote: quote.toString() };
      state.charged = (BigInt(String(state.charged)) + quote).toString();
      await writePrivate(path, JSON.stringify(state));
      let first = true;
      const cachedFetch: typeof fetch = async (input, init) => {
        if (first) {
          first = false;
          return challenge;
        }
        return boundedResponse(
          await fetchFn(input, {
            ...init,
            signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), signal]),
          }),
        );
      };
      const payer = new Payer({
        ...payerDeps,
        modelLane: { path: '/api/model-proxy/messages', ceilingAtomic: quote, origin: this.origin },
        fetchImpl: cachedFetch,
      });
      let result;
      try {
        result = await payer
          .routeFor(baseUrl)
          .send(url, { method: 'POST', jsonBody: body, timeoutMs: 180_000, blockRedirects: true });
      } catch (cause) {
        throw new Error(
          `Model call uncertain (${body.invocationId}); recover its receipt before retrying`,
          { cause },
        );
      } finally {
        // A stopped upstream socket does not erase signed payment exposure.
        // Drain SDK accounting before the worker reports quiescence.
        await payer.idle();
      }
      if (!result.ok || result.status !== 200)
        throw new Error('Model call uncertain; inspect invocation receipt before retrying');
      const value = this.receipt(result.json, body.invocationId, quote);
      state.charged = (BigInt(String(state.charged)) - quote + BigInt(value.actual)).toString();
      await writePrivate(resultFile, JSON.stringify(value.message));
      calls[key] = { ...calls[key]!, completed: true, actual: value.actual };
      await writePrivate(path, JSON.stringify(state));
      return value.message;
    });
  }

  private receipt(raw: unknown, invocationId: string, quote: bigint) {
    const value = z
      .object({
        message: z.record(z.string(), z.unknown()),
        receipt: z.object({
          invocationId: z.literal(invocationId),
          quoteAtomic: z.literal(quote.toString()),
          actualAtomic: z.string().regex(/^\d+$/),
        }),
      })
      .safeParse(raw);
    if (!value.success || BigInt(value.data.receipt.actualAtomic) > quote)
      throw new Error('Invalid model receipt; exposure remains reserved');
    return { message: value.data.message, actual: value.data.receipt.actualAtomic };
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

  /** Actual completed usage plus conservative reservations for uncertain calls. */
  async summary(job: ModelJob) {
    const path = join(this.options.dataDir, 'model-jobs', `${job.id}.budget.json`);
    const parsed = budgetSchema.safeParse(await readJsonFile(path, 1_000_000));
    const routing = String(job.decision.routingFeeAtomic ?? '3000');
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
