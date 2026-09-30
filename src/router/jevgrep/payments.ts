import { jevgrepProfile, type JevgrepProfileId } from './profile';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runPay } from '../../commands/pay';
import type { CommandContext } from '../../context';
import { ErrorCodeSchema } from '../../schemas';
import { writeFileAtomicExclusive } from '../../lib/atomic-json';
import { CliError } from '../../lib/errors';
import { validatedX402Failure } from '../../lib/x402-diagnostic';
import { withFileLock } from '../../lib/lock';
import { canonicalHash } from '../../lib/request-schema';
import { resolveWalletProvider, type WalletProvider, type SpendAuthorizer } from '../../lib/wallet';
import type { TenjinSigner } from '../../lib/wallet/provider';
import {
  validateNativeRequest,
  validateNativeResponse,
  type NativeEvaluationResponse,
} from './protocol';
import { jevgrepSupplier, type JevgrepSupplier } from './supplier';
import { encodeMapleRequest, validateMapleResponse } from './maple';

export { JEVGREP_SUPPLIER } from './supplier';

export interface JevgrepPayerOptions {
  ctx: CommandContext;
  provider?: WalletProvider;
  signer?: TenjinSigner;
  authorizer: SpendAuthorizer;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  runId: string;
  profile?: JevgrepProfileId;
  maxRunAtomic: bigint;
  supplier: JevgrepSupplier;
}

function refuse(message: string): never {
  throw new CliError('REFUSED', message);
}

async function readRecord(path: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(path);
    if (raw.length > 300_000) return refuse('The saved evaluation exceeds its bound.');
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return refuse('Saved evaluation state needs recovery; no replacement payment was made.');
  }
}

async function saveRecord(path: string, value: unknown): Promise<void> {
  await writeFileAtomicExclusive(path, JSON.stringify(value), { mode: 0o600, dirMode: 0o700 });
}

/** Bound both unpaid challenge and paid response bodies before the shared HTTP reader. */
function boundedFetch(implementation: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const response = await implementation(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > 262_144) {
            await reader.cancel();
            controller.error(new Error('Evaluation response exceeds its limit.'));
          } else controller.enqueue(next.value);
        } catch {
          controller.error(new Error('Evaluation response could not be read.'));
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

type FailurePhase = 'payment' | 'response_validation' | 'response_persistence';

/** Only closed-vocabulary diagnostics cross the provider error boundary. */
function failureDiagnostic(error: unknown, phase: FailurePhase, aborted: boolean) {
  const code = error instanceof CliError ? ErrorCodeSchema.safeParse(error.code) : undefined;
  const details =
    error instanceof CliError && typeof error.details === 'object' && error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;
  const status = details?.status;
  const reason = details?.reason;
  const paymentFailure = validatedX402Failure(details?.paymentFailure);
  return {
    code: aborted ? 'ABORTED' : code?.success ? code.data : 'UNKNOWN',
    phase,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(reason === 'balance_unavailable' || reason === 'insufficient_funds' ? { reason } : {}),
    ...(paymentFailure !== undefined ? { paymentFailure } : {}),
  };
}

/** One run, one supplier, and no automatic replacement for an unresolved payment. */
export function createJevgrepPayer(options: JevgrepPayerOptions) {
  const policy = jevgrepProfile(options.profile);
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(options.runId) ||
    options.maxRunAtomic <= 0n ||
    options.maxRunAtomic > policy.maxRunAtomic
  )
    refuse('Invalid search payment scope or budget.');
  const supplier = jevgrepSupplier(options.supplier.id);
  if (canonicalHash(options.supplier) !== canonicalHash(supplier))
    refuse('The search supplier does not match the approved payment terms.');
  const authorizer = options.authorizer;
  if (!authorizer.markSigned || !authorizer.durableSummary)
    refuse('The wallet does not support durable search payments.');
  const provider = options.provider ?? resolveWalletProvider(options.ctx);
  const journalRoot = join(options.ctx.dataDir, 'jevgrep', 'payments');
  const directory = join(journalRoot, canonicalHash(options.runId));
  const active = new Map<string, Promise<NativeEvaluationResponse>>();
  const lifecycle = new AbortController();
  let closePromise: Promise<{ drainCompleted: boolean; pendingEvaluations: number }> | undefined;
  let requests = 0;
  let replays = 0;

  async function initialize() {
    options.signal?.throwIfAborted();
    // Fail before even the unpaid provider probe if durable accounting is unreadable.
    await authorizer.durableSummary!(options.runId);
    const wallet = await provider.describe();
    const scope = {
      version: 1,
      runId: options.runId,
      wallet: wallet.address.toLowerCase(),
      supplier,
      maxRunAtomic: options.maxRunAtomic.toString(),
      ...(policy.id === 'extended-v1' ? { profile: policy.id } : {}),
    };
    const path = join(directory, 'scope.json');
    await mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await withFileLock(join(journalRoot, 'admission.lock'), async () => {
      if ((await readRecord(path)) !== undefined) return;
      // No silent eviction of payment evidence. Exhaustion requires explicit recovery.
      if ((await readdir(journalRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length >= 256)
        refuse('The durable search journal is full; preserve it for recovery.');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await saveRecord(path, scope);
    });
    if (canonicalHash(await readRecord(path)) !== canonicalHash(scope))
      refuse('The saved run belongs to different payment terms or a different wallet.');
  }

  async function execute(body: unknown, signal?: AbortSignal): Promise<NativeEvaluationResponse> {
    // Freeze the exact request before the first asynchronous operation.
    const request = validateNativeRequest(
      JSON.parse(JSON.stringify(validateNativeRequest(body, policy.id))),
      policy.id,
    );
    const rawBody =
      supplier.id === 'maple-jev'
        ? encodeMapleRequest(request, policy.id)
        : JSON.stringify(request);
    const validateResponse =
      supplier.id === 'maple-jev' ? validateMapleResponse : validateNativeResponse;
    const combined = AbortSignal.any([
      AbortSignal.timeout(120_000),
      lifecycle.signal,
      ...[options.signal, signal].filter((item): item is AbortSignal => item !== undefined),
    ]);
    combined.throwIfAborted();
    await initialize();
    const identity = canonicalHash({ runId: options.runId, supplier, request });
    const responsePath = join(directory, `${identity}.response.json`);
    const attemptPath = join(directory, `${identity}.attempt.json`);
    const failedPath = join(directory, `${identity}.failed.json`);
    const replay = async () => {
      const saved = await readRecord(responsePath);
      if (saved === undefined) return undefined;
      const response = validateResponse(saved, request);
      replays++;
      return response;
    };
    const saved = await replay();
    if (saved) return saved;
    try {
      await withFileLock(join(directory, 'admission.lock'), async () => {
        combined.throwIfAborted();
        const previous = await readRecord(attemptPath);
        if (previous !== undefined)
          throw Object.assign(new Error('Existing evaluation'), { code: 'EEXIST' });
        // A run is finite even if every evaluation was free or failed before signing.
        if (
          (await readdir(directory)).filter((name) => name.endsWith('.attempt.json')).length >=
          policy.limits.requests
        )
          refuse('The search evaluation limit was reached.');
        await saveRecord(attemptPath, { version: 1, identity });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const attempt = await readRecord(attemptPath);
      if (canonicalHash(attempt) !== canonicalHash({ version: 1, identity }))
        refuse('The saved evaluation identity is invalid.');
      // Another process may still be finishing it. Only its response can satisfy this request.
      const deadline = Date.now() + 65_000;
      while (Date.now() < deadline) {
        combined.throwIfAborted();
        const completed = await replay();
        if (completed) return completed;
        if ((await readRecord(failedPath)) !== undefined) break;
        await delay(50, undefined, { signal: combined });
      }
      refuse('An earlier evaluation needs recovery; no duplicate payment was sent.');
    }
    requests++;
    let reservationId: string | undefined;
    let paymentPrepared = false;
    let phase: FailurePhase = 'payment';
    const scopedAuthorizer: SpendAuthorizer = {
      policyEnforcement: authorizer.policyEnforcement,
      async authorize(requested) {
        combined.throwIfAborted();
        const authorization = await authorizer.authorize({
          ...requested,
          requestKey: identity,
          durableRun: { id: options.runId, maxAtomic: options.maxRunAtomic },
        });
        reservationId = authorization.reservationId;
        return authorization;
      },
      commit: (id, amount, settings) => authorizer.commit(id, amount, settings),
      release: (id) => authorizer.release(id),
    };
    try {
      const paid = await runPay(
        {
          url: supplier.url,
          method: 'POST',
          rawBody,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          execution: 'router',
          requestKey: identity,
          printBody: true,
          terms: {
            source: supplier.id,
            network: supplier.network,
            asset: supplier.asset,
            payTo: supplier.payTo,
            maxAmountAtomic: supplier.maxAmountAtomic,
          },
        },
        options.ctx,
        {
          provider,
          authorizer: scopedAuthorizer,
          signal: combined,
          fetchImpl: boundedFetch(options.fetchImpl ?? fetch),
          confirm: async () => false,
          async beforePayment(payment) {
            combined.throwIfAborted();
            if (
              !reservationId ||
              payment.url !== supplier.url ||
              BigInt(payment.amountAtomic) > BigInt(supplier.maxAmountAtomic)
            )
              refuse('The payment does not match its durable reservation.');
            paymentPrepared = true;
            await authorizer.markSigned!(reservationId);
            combined.throwIfAborted();
          },
        },
      );
      phase = 'response_validation';
      const data = paid.data as { bodyText?: string };
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.bodyText ?? '');
      } catch {
        refuse('The provider did not return a valid evaluation.');
      }
      const response = validateResponse(parsed, request);
      phase = 'response_persistence';
      await saveRecord(responsePath, response);
      return response;
    } catch (error) {
      // Do not persist raw provider errors, source, headers, or signatures.
      const diagnostic = failureDiagnostic(error, phase, combined.aborted);
      await saveRecord(failedPath, {
        version: 1,
        state: paymentPrepared ? 'uncertain' : 'untransmitted',
        diagnostic,
      }).catch(() => undefined);
      if (combined.aborted) combined.throwIfAborted();
      if (!paymentPrepared && error instanceof CliError && error.code === 'POLICY_REFUSED')
        throw new CliError(
          'POLICY_REFUSED',
          'The search payment budget was refused; no payment was transmitted.',
          { details: { reason: 'budget', diagnostic } },
        );
      throw new CliError(
        'REFUSED',
        paymentPrepared
          ? 'The evaluation failed or its payment is uncertain; no replacement payment was authorized.'
          : 'The evaluation failed before payment transmission; no replacement payment was authorized.',
        { details: { reason: paymentPrepared ? 'payment_uncertain' : 'provider', diagnostic } },
      );
    }
  }

  return {
    evaluate(body: unknown, signal?: AbortSignal): Promise<NativeEvaluationResponse> {
      if (lifecycle.signal.aborted) return Promise.reject(new Error('The search payer is closed.'));
      const key = canonicalHash(body);
      const pending = active.get(key);
      if (pending) {
        replays++;
        return pending;
      }
      const operation = execute(body, signal).finally(() => active.delete(key));
      active.set(key, operation);
      return operation;
    },
    close() {
      closePromise ??= (async () => {
        lifecycle.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...active.values()]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 10_000);
            }),
          ]);
          return { drainCompleted: active.size === 0, pendingEvaluations: active.size };
        } finally {
          clearTimeout(timer);
        }
      })();
      return closePromise;
    },
    async summary() {
      return { ...(await authorizer.durableSummary!(options.runId)), requests, replays };
    },
  };
}
