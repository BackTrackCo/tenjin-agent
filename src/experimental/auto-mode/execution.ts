import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { z } from 'zod';
import { fsyncDir, writeFileAtomic } from '../../lib/atomic-json';
import { withFileLock } from '../../lib/lock';
import { USDC_ADDRESS } from '../../lib/usdc';
import type { BuiltPayment } from '../../lib/x402-pay';
import { validateResultBody, validateResultSchema } from './contracts';

export interface AutoHttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AutoHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AutoPolicy {
  /** Stable across processes/sessions for one capped experiment. */
  runId: string;
  revision: string;
  authorization: 'auto' | 'disabled';
  expiresAtMs: number;
  maxCallAtomic: string;
  maxRunAtomic: string;
  allowedOperations: string[];
  /** Optional operator restriction, not a provider admission registry. */
  allowedOrigins?: string[];
  /** Exact method and origin/path scopes; optional query pins are preserved. */
  allowedResources?: { url: string; method: string }[];
}

export interface AutoRequestIdentity {
  sessionId: string;
  requestId: string;
  stepId: string;
  contractHash: string;
  /** Stable URL/method capability identity, independent of seller metadata revisions. */
  capabilityId?: string;
  contextHash: string;
  /** Fingerprint of user messages only; assistant/tool retries cannot renew it. */
  userTurnHash?: string;
}

export interface PaidRequestInput {
  request: AutoHttpRequest;
  identity: AutoRequestIdentity;
  operation: string;
  /** Catalog terms from the pinned contract, independent of the live merchant. */
  advertisedAccepts: unknown[];
  /** Trusted local contract condition; never derived from provider result content. */
  resultSchema?: Record<string, unknown>;
}

export interface ExecutionResult {
  status: 'fulfilled' | 'needs_approval' | 'refused' | 'unsupported' | 'failed' | 'pending';
  reason?: string;
  response?: AutoHttpResponse;
  amountAtomic?: string;
  cached?: boolean;
  diagnostic?: { stage: string; errorName: string; errorCode?: string };
  /** A parsed provider receipt is evidence, not an independently checked on-chain receipt. */
  settlement?: { status: 'reported' | 'unverified'; transaction?: string; reason?: string };
}

export interface ExecutionDeps {
  stateDir: string;
  /** Must reread structured local policy, rather than a model-provided decision. */
  readPolicy: () => Promise<AutoPolicy>;
  signPayment: (quote: PaymentRequired) => Promise<BuiltPayment>;
  /** Injected transports are trusted test seams; production uses safeHttpsTransport. */
  transport?: (
    request: AutoHttpRequest,
    paymentHeaders?: Record<string, string>,
  ) => Promise<AutoHttpResponse>;
  now?: () => number;
  /** Total bounded wait for another request's active payment; never reclaims it. */
  peerWaitMs?: number;
  /** Resolver seam for nested URL preflight; production leaves this unset. */
  nestedTargetValidation?: NestedTargetOptions;
}

export type TargetResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export interface NestedTargetOptions {
  resolveHostname?: TargetResolver;
  /** One total deadline for all nested target resolutions, not per hostname. */
  timeoutMs?: number;
}

export class NestedTargetError extends Error {
  override readonly name = 'NestedTargetError';
}

/**
 * Validate structured URI arguments before contacting the paid endpoint. URL
 * formats/field names establish intent; whole URI-shaped strings catch schemas
 * without formats. Ordinary query prose and CAIP identifiers are not targets.
 *
 * This checks local DNS at preflight time. A remote scraper resolves names and
 * follows redirects on its own server: the caller cannot pin those connections
 * or claim this preflight establishes the scraper's own SSRF isolation.
 */
export async function validateNestedTargets(
  args: unknown,
  schema: unknown = {},
  options: NestedTargetOptions = {},
): Promise<void> {
  const targets = new Set<string>();
  let nodes = 0;
  function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  function walk(value: unknown, rawSchema: unknown, field = '', depth = 0): void {
    if (++nodes > 4000 || depth > 24)
      throw new NestedTargetError('Nested arguments exceed the target validation limit.');
    const current = record(rawSchema);
    if (typeof value === 'string') {
      const formatted = ['uri', 'uri-reference', 'url'].includes(String(current.format));
      const named =
        /(?:^|[_-])(?:url|uri|urls|uris)$/.test(field) ||
        /(?:Url|URL|Uri|URI|Urls|URLs|Uris|URIs)$/.test(field);
      const text = value.trim();
      const wholeUri =
        !/\s/.test(text) &&
        (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ||
          /^(?:https?|file|gopher|ftp|ftps|wss?|data|javascript|mailto):/i.test(text) ||
          text.startsWith('//'));
      if (!formatted && !named && !wholeUri) return;
      if (value !== text || /\s/.test(text))
        throw new NestedTargetError(
          'A structured URI argument is not a valid public HTTPS target.',
        );
      try {
        assertRequestSafe({ url: text, method: 'GET' });
      } catch {
        throw new NestedTargetError(
          'A structured URI argument is not an eligible public HTTPS target.',
        );
      }
      targets.add(text);
      if (targets.size > 32)
        throw new NestedTargetError('At most 32 distinct nested URL targets are supported.');
    } else if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        const childSchema = Array.isArray(current.prefixItems)
          ? (current.prefixItems[index] ?? current.items)
          : current.items;
        walk(child, childSchema, field, depth + 1);
      }
    } else if (value !== null && typeof value === 'object') {
      const properties = record(current.properties);
      for (const [key, child] of Object.entries(value))
        walk(child, properties[key] ?? current.additionalProperties, key, depth + 1);
    }
  }
  walk(args, schema);
  if (targets.size === 0) return;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)
    throw new NestedTargetError('Nested target timeout must be between 1 and 20000 milliseconds.');
  const resolveHostname =
    options.resolveHostname ?? ((hostname: string) => lookup(hostname, { all: true }));
  const deadline = Date.now() + timeoutMs;
  const checkedHosts = new Set<string>();
  for (const target of targets) {
    const hostname = new URL(target).hostname.replace(/^\[|\]$/g, '');
    if (checkedHosts.has(hostname)) continue;
    checkedHosts.add(hostname);
    if (isIP(hostname)) {
      if (!isPublicAddress(hostname))
        throw new NestedTargetError(
          'A nested target resolves to a private or unsupported network address.',
        );
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NestedTargetError('Nested target DNS validation timed out.');
      const addresses = await Promise.race([
        resolveHostname(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new NestedTargetError('Nested target DNS validation timed out.')),
            remaining,
          );
        }),
      ]);
      if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new NestedTargetError(
          'A nested target resolves to a private or unsupported network address.',
        );
      }
    } catch (error) {
      if (error instanceof NestedTargetError) throw error;
      throw new NestedTargetError('Nested target DNS resolution failed before payment.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const atomic = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const id = z.string().min(1).max(512);
const policySchema = z.object({
  runId: id,
  revision: id,
  authorization: z.enum(['auto', 'disabled']),
  expiresAtMs: z.number().finite().int().positive(),
  maxCallAtomic: atomic,
  maxRunAtomic: atomic,
  allowedOperations: z.array(id).max(100),
  allowedOrigins: z.array(z.string().url()).max(100).optional(),
  allowedResources: z
    .array(z.object({ url: z.string().url(), method: z.string() }))
    .max(100)
    .optional(),
});
const identitySchema = z.object({
  sessionId: id,
  requestId: id,
  stepId: id,
  contractHash: id,
  capabilityId: id.optional(),
  contextHash: id,
  userTurnHash: z.string().length(64).optional(),
});
const responseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string().max(262_144),
});
const resultSchema = z.object({
  status: z.enum(['fulfilled', 'needs_approval', 'refused', 'unsupported', 'failed', 'pending']),
  reason: z.string().optional(),
  response: responseSchema.optional(),
  amountAtomic: atomic.optional(),
  cached: z.boolean().optional(),
  diagnostic: z
    .object({ stage: z.string(), errorName: z.string(), errorCode: z.string().optional() })
    .optional(),
  settlement: z
    .object({
      status: z.enum(['reported', 'unverified']),
      transaction: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});
const attemptSchema = z
  .object({
    key: z.string().length(64),
    fingerprint: z.string().length(64),
    retryGroup: z.string().length(64).optional(),
    requestHash: z.string().length(64).optional(),
    policyRevision: id,
    policyHash: z.string().length(64),
    state: z.enum(['prepared', 'signing', 'transmitted', 'completed', 'cancelled', 'ambiguous']),
    amountAtomic: atomic,
    atMs: z.number().finite(),
    quoteHash: z.string().optional(),
    result: resultSchema.optional(),
  })
  .superRefine((attempt, ctx) => {
    if (attempt.state === 'completed' && attempt.result === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Completed attempt has no saved result.' });
    }
    if (['prepared', 'cancelled'].includes(attempt.state) && attempt.amountAtomic !== '0') {
      ctx.addIssue({ code: 'custom', message: 'Unsigned attempt has inconsistent spend.' });
    }
  });
type Attempt = z.infer<typeof attemptSchema>;
const ledgerSchema = z.object({
  version: z.literal(1),
  runId: id,
  attempts: z.array(attemptSchema).max(1000),
});
type Ledger = z.infer<typeof ledgerSchema>;

/** Canonical JSON avoids key ordering changing the identity of otherwise identical requests. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function header(response: AutoHttpResponse, name: string): string | undefined {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

class StopExecution extends Error {
  constructor(readonly result: ExecutionResult) {
    super(result.reason ?? result.status);
  }
}

/** Internal control flow only: release the ledger mutex before waiting. */
class ActivePeer extends Error {}

function stop(status: ExecutionResult['status'], reason: string): never {
  throw new StopExecution({ status, reason });
}

function checkPolicy(policy: AutoPolicy, input: PaidRequestInput, now: number): void {
  if (policy.authorization !== 'auto') stop('needs_approval', 'Automatic payment is disabled.');
  if (policy.expiresAtMs <= now) stop('needs_approval', 'The payment policy has expired.');
  if (BigInt(policy.maxCallAtomic) <= 0n || BigInt(policy.maxRunAtomic) <= 0n) {
    stop('refused', 'Automatic execution requires positive finite per-call and per-run caps.');
  }
  if (!policy.allowedOperations.includes(input.operation)) {
    stop('needs_approval', `The policy does not permit operation ${input.operation}.`);
  }
  if (
    policy.allowedOrigins !== undefined &&
    !policy.allowedOrigins.includes(new URL(input.request.url).origin)
  ) {
    stop('needs_approval', 'The policy does not permit this endpoint origin.');
  }
  if (policy.allowedResources !== undefined) {
    const request = new URL(input.request.url);
    const permitted = policy.allowedResources.some((scope) => {
      const allowed = new URL(scope.url);
      return (
        scope.method === input.request.method &&
        allowed.protocol === 'https:' &&
        allowed.origin === request.origin &&
        allowed.pathname === request.pathname &&
        (allowed.search === '' || allowed.search === request.search) &&
        !allowed.username &&
        !allowed.password &&
        !allowed.hash
      );
    });
    if (!permitted)
      stop('needs_approval', 'The policy does not permit this concrete resource and method.');
  }
}

const address = /^0x[0-9a-fA-F]{40}$/;
const requirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: atomic,
  payTo: z.string().regex(address),
  maxTimeoutSeconds: z.number().int().min(1).max(3600),
  extra: z.record(z.string(), z.unknown()).optional(),
});

/** Select a supported, catalog-bound alternative, never silently change merchant or asset. */
export function validatePaymentQuote(
  response: AutoHttpResponse,
  requestUrl: string,
  advertisedAccepts: unknown[],
): PaymentRequired {
  const encoded = header(response, 'payment-required');
  if (encoded === undefined || encoded.length > 65_536) {
    stop('unsupported', 'An x402 v2 PAYMENT-REQUIRED header is required.');
  }
  let decoded: PaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(encoded);
  } catch {
    stop('refused', 'The PAYMENT-REQUIRED header is invalid.');
  }
  if (decoded.x402Version !== 2 || !Array.isArray(decoded.accepts)) {
    stop('unsupported', 'Only x402 v2 payment requirements are implemented.');
  }
  let resourceMatches = false;
  try {
    const expected = new URL(requestUrl);
    const resource = new URL(decoded.resource.url);
    resourceMatches =
      resource.origin === expected.origin &&
      resource.pathname === expected.pathname &&
      (resource.search === '' || resource.search === expected.search) &&
      !resource.hash &&
      !resource.username &&
      !resource.password;
  } catch {
    /* Malformed or missing resource URL is a refused quote. */
  }
  if (!resourceMatches) {
    stop('refused', 'The quoted resource does not match the concrete request URL.');
  }
  const supported = decoded.accepts
    .map((item) => requirementSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .filter(
      (term) =>
        term.scheme === 'exact' &&
        term.network === 'eip155:8453' &&
        term.asset.toLowerCase() === USDC_ADDRESS.toLowerCase(),
    );
  if (supported.length === 0) {
    stop('unsupported', 'Only exact payments in native USDC on Base are implemented.');
  }
  const matches = supported.filter((live) =>
    advertisedAccepts.some((raw) => {
      if (raw === null || typeof raw !== 'object') return false;
      const advertised = raw as Record<string, unknown>;
      const amount = advertised.amount ?? advertised.maxAmountRequired;
      return (
        advertised.scheme === live.scheme &&
        advertised.network === live.network &&
        typeof advertised.asset === 'string' &&
        advertised.asset.toLowerCase() === live.asset.toLowerCase() &&
        typeof advertised.payTo === 'string' &&
        advertised.payTo.toLowerCase() === live.payTo.toLowerCase() &&
        (amount === undefined ||
          (atomic.safeParse(amount).success && BigInt(live.amount) <= BigInt(amount as string)))
      );
    }),
  );
  const selected = matches.sort((a, b) =>
    BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0,
  )[0];
  if (selected === undefined) {
    stop(
      'refused',
      'The live quote changes the catalog merchant, asset, network, scheme, or ceiling.',
    );
  }
  // Arbitrary seller extensions never alter the signer; known SDK builder attribution is safe.
  return {
    ...decoded,
    accepts: [{ ...selected, network: 'eip155:8453', extra: selected.extra ?? {} }],
  };
}

function settlement(response: AutoHttpResponse): NonNullable<ExecutionResult['settlement']> {
  const encoded = header(response, 'payment-response');
  if (encoded === undefined)
    return { status: 'unverified', reason: 'No PAYMENT-RESPONSE receipt.' };
  try {
    const receipt = decodePaymentResponseHeader(encoded);
    if (
      receipt.success === true &&
      receipt.network === 'eip155:8453' &&
      /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction)
    ) {
      return { status: 'reported', transaction: receipt.transaction };
    }
  } catch {
    // Receipt parsing failure never refunds a transmitted authorization's budget.
  }
  return { status: 'unverified', reason: 'Missing or incompatible successful settlement receipt.' };
}

/**
 * Local cooperative payment executor. No model decision is accepted as authority.
 * A claimed attempt is never automatically reclaimed after a crash; ambiguous
 * signing/transmission requires reconciliation. Same-OS-user code can edit these
 * files or call the wallet directly: this is not an adversarial wallet boundary.
 */
export async function executePaidRequest(
  input: PaidRequestInput,
  deps: ExecutionDeps,
): Promise<ExecutionResult> {
  const now = deps.now ?? Date.now;
  const transport = deps.transport ?? safeHttpsTransport;
  let attemptedKey: string | undefined;
  let ledgerPath: string | undefined;
  let policy: AutoPolicy;
  let currentState: Attempt['state'] | undefined;
  let stage = 'configuration';
  try {
    const peerWaitMs = deps.peerWaitMs ?? 10_000;
    if (!Number.isInteger(peerWaitMs) || peerWaitMs < 0 || peerWaitMs > 10_000)
      throw new Error('Peer wait must be between 0 and 10000 milliseconds.');
    // Shared by claim and reservation, independently of the injected policy clock.
    let peerDeadline: number | undefined;
    identitySchema.parse(input.identity);
    assertRequestSafe(input.request);
    if (input.resultSchema !== undefined) {
      stage = 'result-contract-validation';
      validateResultSchema(input.resultSchema);
    }
    policy = policySchema.parse(await deps.readPolicy());
    const policyHash = hash(policy);
    const key = hash([input.identity.sessionId, input.identity.requestId, input.identity.stepId]);
    const fingerprint = hash(input);
    const resource = new URL(input.request.url);
    const capabilityId =
      input.identity.capabilityId ??
      hash([input.request.method, resource.origin, resource.pathname]);
    const retryGroup =
      input.identity.userTurnHash &&
      hash([input.identity.sessionId, input.identity.userTurnHash, capabilityId]);
    const requestHash = hash(input.request);
    ledgerPath = join(deps.stateDir, `run-${hash(policy.runId)}.json`);
    const path = ledgerPath;
    await mkdir(deps.stateDir, { recursive: true, mode: 0o700 });

    async function withLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
      return withFileLock(`${path}.lock`, async () => {
        let ledger: Ledger;
        try {
          if ((await stat(path)).size > 32 * 1024 * 1024) {
            stop(
              'refused',
              'Execution ledger exceeds its storage limit; archive the run explicitly.',
            );
          }
          const raw = await readFile(path, 'utf8');
          ledger = ledgerSchema.parse(JSON.parse(raw));
          if (ledger.runId !== policy.runId)
            stop('refused', 'The execution ledger run does not match.');
          if (
            new Set(ledger.attempts.map((attempt) => attempt.key)).size !== ledger.attempts.length
          ) {
            stop('refused', 'Execution ledger contains duplicate request identities.');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            ledger = { version: 1, runId: policy.runId, attempts: [] };
          } else if (error instanceof StopExecution) throw error;
          else
            stop('refused', 'Execution ledger is unreadable or corrupt; refusing to reset spend.');
        }
        return fn(ledger);
      });
    }

    async function withReadyLedger<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
      let resumed = false;
      for (;;) {
        if (resumed) await recheckPolicy();
        try {
          return await withLedger(fn);
        } catch (error) {
          if (!(error instanceof ActivePeer)) throw error;
          peerDeadline ??= performance.now() + peerWaitMs;
          const remaining = peerDeadline - performance.now();
          if (remaining <= 0)
            throw new StopExecution({
              status: 'pending',
              amountAtomic: '0',
              reason:
                'Another request to this service still has an unresolved payment attempt. The bounded wait expired; no new payment was made. Its saved outcome must resolve before this request can proceed.',
            });
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
          resumed = true;
        }
      }
    }

    async function persist(ledger: Ledger): Promise<void> {
      const serialized = `${JSON.stringify(ledger)}\n`;
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
        stop('refused', 'Execution ledger reached its storage limit.');
      await writeFileAtomic(path, serialized, { mode: 0o600, dirMode: 0o700 });
      // The shared rename helper is atomic, but money state must also survive a
      // machine crash before we sign or transmit. Flush file then directory.
      const handle = await open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== 'win32') await fsyncDir(deps.stateDir);
    }

    function pendingRetry(ledger: Ledger): ExecutionResult | undefined {
      const peers = retryGroup
        ? ledger.attempts.filter(
            (attempt) => attempt.key !== key && attempt.retryGroup === retryGroup,
          )
        : [];
      // Exact duplicates and unresolved failures never become new paid attempts
      // merely because another call finishes. Check them before waitable work.
      if (
        peers.some(
          (attempt) =>
            (attempt.requestHash === requestHash &&
              ['prepared', 'signing', 'transmitted'].includes(attempt.state)) ||
            (BigInt(attempt.amountAtomic) > 0n &&
              (attempt.state === 'ambiguous' ||
                (attempt.state === 'completed' && attempt.result?.status !== 'fulfilled'))),
        )
      ) {
        return {
          status: 'pending',
          amountAtomic: '0',
          reason:
            'An identical request is in flight, or this service has an unresolved paid attempt in the current user turn. No new payment was made. Reconcile it before retrying; changing tool IDs or arguments does not renew authorization.',
        };
      }
      // Different requests may obtain unsigned quotes concurrently, but only
      // one payment in this group may be active. Wait for durable completion,
      // then repeat every ledger/policy check; never infer success from age/PID.
      if (
        peers.some(
          (attempt) =>
            BigInt(attempt.amountAtomic) > 0n && ['signing', 'transmitted'].includes(attempt.state),
        )
      )
        throw new ActivePeer();
      return undefined;
    }

    stage = 'claim';
    const existing = await withReadyLedger(async (ledger) => {
      const prior = ledger.attempts.find((attempt) => attempt.key === key);
      if (prior !== undefined && prior.fingerprint !== fingerprint) {
        stop(
          'refused',
          'This request ID is already bound to different arguments, context, or contract.',
        );
      }
      if (prior?.state === 'completed') return { ...prior.result!, cached: true };
      if (prior !== undefined && prior.state !== 'cancelled') {
        return {
          status: 'pending' as const,
          reason:
            'An attempt already owns this request. Resume its saved result or reconcile it; do not sign again.',
          amountAtomic: prior.amountAtomic,
        };
      }
      checkPolicy(policy, input, now());
      const retry = pendingRetry(ledger);
      if (retry) return retry;
      if (ledger.attempts.length >= 1000)
        stop('refused', 'This run has reached its attempt limit.');
      const attempt: Attempt = {
        key,
        fingerprint,
        ...(retryGroup ? { retryGroup, requestHash } : {}),
        policyRevision: policy.revision,
        policyHash,
        state: 'prepared',
        amountAtomic: '0',
        atMs: now(),
      };
      ledger.attempts = [...ledger.attempts.filter((item) => item.key !== key), attempt];
      await persist(ledger);
      return undefined;
    });
    if (existing !== undefined) return existing;
    attemptedKey = key;
    currentState = 'prepared';

    async function update(state: Attempt['state'], extra: Partial<Attempt> = {}): Promise<void> {
      await withLedger(async (ledger) => {
        const attempt = ledger.attempts.find((item) => item.key === key);
        if (attempt === undefined)
          stop('refused', 'The owned attempt is missing; refusing execution.');
        Object.assign(attempt, extra, { state });
        await persist(ledger);
      });
      currentState = state;
    }

    async function recheckPolicy(): Promise<void> {
      const fresh = policySchema.parse(await deps.readPolicy());
      checkPolicy(fresh, input, now());
      if (hash(fresh) !== policyHash) {
        stop(
          'needs_approval',
          'Payment policy changed during the attempt; reevaluate without transmitting.',
        );
      }
    }

    stage = 'unsigned-request';
    const probe = responseSchema.parse(await transport(input.request));
    if (probe.status >= 300 && probe.status <= 399)
      stop('refused', 'Endpoint redirects are refused.');
    if (probe.status >= 200 && probe.status <= 299) {
      const resultCheck = input.resultSchema
        ? validateResultBody(input.resultSchema, probe.body)
        : { valid: true };
      const result: ExecutionResult = {
        status: resultCheck.valid ? 'fulfilled' : 'failed',
        ...(resultCheck.valid ? {} : { reason: `${resultCheck.reason} No automatic retry.` }),
        response: probe,
        amountAtomic: '0',
      };
      await update('completed', { result });
      return result;
    }
    if (probe.status !== 402) stop('failed', `Unsigned endpoint returned HTTP ${probe.status}.`);
    stage = 'quote-validation';
    const quote = validatePaymentQuote(probe, input.request.url, input.advertisedAccepts);
    const amount = BigInt(quote.accepts[0]!.amount);
    stage = 'policy-recheck';
    await recheckPolicy();
    stage = 'reserve-budget';
    await withReadyLedger(async (ledger) => {
      const attempt = ledger.attempts.find((item) => item.key === key)!;
      // Distinct requests may obtain unsigned quotes together, but only one
      // unresolved payment per service/user turn may reserve or sign. Recheck
      // under the reservation lock: both callers may have passed the claim.
      const retry = pendingRetry(ledger);
      if (retry) throw new StopExecution(retry);
      const spent = ledger.attempts.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
      if (amount > BigInt(policy.maxCallAtomic))
        stop('refused', 'The quote exceeds the per-call cap.');
      if (spent + amount > BigInt(policy.maxRunAtomic))
        stop('refused', 'The quote exceeds the remaining run cap.');
      Object.assign(attempt, {
        state: 'signing',
        amountAtomic: amount.toString(),
        quoteHash: hash(quote),
      });
      await persist(ledger);
    });
    currentState = 'signing';
    stage = 'sign-payment';
    const payment = await deps.signPayment(quote);
    if (payment.amountAtomic !== amount)
      stop('refused', 'The signer returned an inconsistent amount.');
    try {
      stage = 'policy-recheck';
      await recheckPolicy();
    } catch (error) {
      // Signature only exists in this process and was never sent. It is discarded.
      await update('cancelled', { amountAtomic: '0' });
      throw error;
    }
    // Persist BEFORE the first possible network transmission. A crash in this
    // small gap conservatively counts the reservation; retry cannot sign again.
    stage = 'record-transmission';
    await update('transmitted');
    try {
      stage = 'policy-recheck';
      await recheckPolicy();
    } catch (error) {
      // The durable marker precedes the actual send, so explicit revocation can
      // still discard the signature without transmission or spending.
      await update('cancelled', { amountAtomic: '0' });
      throw error;
    }
    stage = 'paid-request';
    const paid = responseSchema.parse(await transport(input.request, payment.headers));
    const httpSuccess = paid.status >= 200 && paid.status <= 299;
    const resultCheck =
      httpSuccess && input.resultSchema
        ? validateResultBody(input.resultSchema, paid.body)
        : { valid: true };
    const result: ExecutionResult = {
      status: httpSuccess && resultCheck.valid ? 'fulfilled' : 'failed',
      ...(!httpSuccess
        ? { reason: `Paid endpoint returned HTTP ${paid.status}; no automatic retry.` }
        : resultCheck.valid
          ? {}
          : { reason: `${resultCheck.reason} No automatic retry.` }),
      response: paid,
      amountAtomic: amount.toString(),
      settlement: settlement(paid),
    };
    stage = 'save-result';
    await update('completed', { result });
    return result;
  } catch (error) {
    const safeNames = new Set([
      'Error',
      'TypeError',
      'RangeError',
      'ZodError',
      'AbortError',
      'TimeoutError',
      'CliError',
      'LockTimeoutError',
    ]);
    const safeCodes = new Set([
      'EACCES',
      'EPERM',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ABORT_ERR',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
    ]);
    const rawName = error instanceof Error ? error.name : '';
    const rawCode =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const errorName = safeNames.has(rawName) ? rawName : 'UnknownError';
    const errorCode = typeof rawCode === 'string' && safeCodes.has(rawCode) ? rawCode : undefined;
    const diagnostic = { stage, errorName, ...(errorCode ? { errorCode } : {}) };
    const result: ExecutionResult =
      error instanceof StopExecution
        ? error.result
        : {
            status: 'failed',
            reason: `Execution failed during ${stage} (${errorName}${errorCode ? `, ${errorCode}` : ''}). No automatic retry.`,
            diagnostic,
          };
    if (attemptedKey !== undefined && ledgerPath !== undefined && currentState !== 'cancelled') {
      try {
        const path = ledgerPath;
        await withFileLock(`${path}.lock`, async () => {
          const ledger = ledgerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
          const attempt = ledger.attempts.find((item) => item.key === attemptedKey);
          if (attempt !== undefined && attempt.state !== 'completed') {
            const ambiguous = ['signing', 'transmitted', 'ambiguous'].includes(attempt.state);
            const unsigned = attempt.state === 'prepared' && BigInt(attempt.amountAtomic) === 0n;
            if (!ambiguous && !unsigned) return;
            attempt.state = ambiguous ? 'ambiguous' : 'cancelled';
            if (ambiguous) {
              result.amountAtomic = attempt.amountAtomic;
              result.reason = `${result.reason ?? 'Execution failed.'} Signing or transmission may have occurred; retained budget requires reconciliation.`;
            }
            const savedResult: ExecutionResult = unsigned
              ? {
                  ...result,
                  amountAtomic: '0',
                  reason: `${result.reason ?? 'Execution failed.'} No payment was signed or sent for this attempt.`,
                }
              : result;
            attempt.result = savedResult;
            await writeFileAtomic(path, `${JSON.stringify(ledger)}\n`, {
              mode: 0o600,
              dirMode: 0o700,
            });
            const handle = await open(path, 'r');
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            if (process.platform !== 'win32') await fsyncDir(deps.stateDir);
            // Do not assert zero payment when reading or durably saving the
            // pre-signing cancellation failed. Signed states stay ambiguous.
            if (unsigned) Object.assign(result, savedResult);
          }
        });
      } catch {
        // Keep the earlier claim/reservation. Never replace unreadable state.
      }
    }
    return result;
  }
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(base, prefix, 'ipv4');
for (const [base, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockedV6.addSubnet(base, prefix, 'ipv6');

export function isPublicAddress(value: string): boolean {
  const kind = isIP(value);
  return kind === 4
    ? !blockedV4.check(value, 'ipv4')
    : kind === 6 && /^[23]/i.test(value) && !blockedV6.check(value, 'ipv6');
}

export function assertRequestSafe(request: AutoHttpRequest): void {
  const url = new URL(request.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port !== '' && url.port !== '443') ||
    request.url.length > 16_384 ||
    /(?:^|\.)(?:localhost|local|internal|home|lan)$/i.test(url.hostname)
  )
    stop(
      'refused',
      'Only public HTTPS endpoints without credentials, fragments, or custom ports are allowed.',
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname))
    stop('refused', 'Private network endpoints are refused.');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method)) {
    stop('unsupported', 'Unsupported HTTP method.');
  }
  if (request.body !== undefined && Buffer.byteLength(request.body) > 262_144) {
    stop('refused', 'The request body exceeds its limit.');
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (
      !['accept', 'content-type'].includes(name.toLowerCase()) ||
      value.length > 1024 ||
      /[\r\n]/.test(value)
    ) {
      stop(
        'unsupported',
        'Only bounded Accept and Content-Type headers are supported by the local runner.',
      );
    }
  }
}

/** DNS results are checked then pinned to this connection, eliminating DNS rebinding between checks. */
export async function safeHttpsTransport(
  request: AutoHttpRequest,
  paymentHeaders: Record<string, string> = {},
): Promise<AutoHttpResponse> {
  assertRequestSafe(request);
  const url = new URL(request.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(20_000);
  const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>((resolve, reject) => {
    const onAbort = () =>
      reject(
        Object.assign(new Error('DNS lookup timed out.'), {
          name: 'TimeoutError',
          code: 'ETIMEDOUT',
        }),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    lookup(host, { all: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    stop('refused', 'Endpoint DNS includes a private or unsupported network address.');
  }
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    // HTTPS forwards socket options, although its RequestOptions type does not
    // expose net.Socket's autoSelectFamily option in the installed Node types.
    const options: RequestOptions & { autoSelectFamily: true } = {
      method: request.method,
      headers: {
        ...request.headers,
        ...paymentHeaders,
        'Accept-Encoding': 'identity',
        // Public automation APIs can reject anonymous HTTP clients. Identify
        // this runner honestly; never inherit a model-supplied browser identity.
        'User-Agent': 'tenjin-cli/0.1 (local-x402-experiment)',
      },
      signal,
      agent: false,
      autoSelectFamily: true,
      // Node can race/fall back between already validated connection addresses.
      // This is connection establishment, not an HTTP/payment retry; no second
      // DNS lookup or resending of an authorization occurs after transmission.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, pinned.address, pinned.family);
      },
    };
    const outgoing = httpsRequest(url, options, (incoming) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 262_144) {
          outgoing.destroy(new Error('Response exceeds its limit.'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'payment-required', 'payment-response']) {
          const value = incoming.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        resolve({
          status: incoming.statusCode ?? 500,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(request.body);
  });
}
