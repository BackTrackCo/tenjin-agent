import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { z } from 'zod';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { HttpRequestOptions, HttpResponse } from '../lib/http';
import { gateSpend } from '../lib/spend-gate';
import type { SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import { buildExactPayment } from '../lib/x402-pay';
import type { CommandContext } from '../context';
import type { Packet } from './context';

/**
 * `POST /api/x402-router`: one paid decision per lookup, made on the actual
 * call. The fee is reserved through the same spend gate every other payment
 * passes, and the response carries the executable contract the tool then runs.
 *
 * NOTHING NON-SPEC GOES ON THE WIRE. The only optimisation here is reusing the
 * challenge this session already decoded so the second lookup skips its 402
 * probe: the same standard `PAYMENT-SIGNATURE` header, built from the same
 * decoded requirements. A 402 that answers with a FRESH challenge before the
 * handler ran means the cached requirements are stale, so the cache is replaced
 * and the call retried once, under the same request id and with every spending
 * check run again on the new terms. A 402 that reports a settlement failure
 * after the handler ran is a paid failure: nothing signs twice.
 */

export const ROUTER_PATH = '/api/x402-router';

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

/**
 * THE REQUEST IS THE SERVER'S TO BUILD. It owns the capability records and the
 * binding rules, so it returns the finished call and this client sends it
 * verbatim: no query assembly, no body encoding, no header invention here. What
 * the client still owns is everything that decides whether to send it at all,
 * which is the destination preflight, the argument and result validation, and
 * every spending check.
 */
const RequestSchema = z.object({
  url: z.string().min(1).max(16_384),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  headers: z.record(z.string(), z.string()),
  body: z
    .string()
    .max(256 * 1024)
    .optional(),
});
export type DecisionRequestShape = z.infer<typeof RequestSchema>;

const ContractSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().min(1).max(16_384),
  /** Flat, for display and for the schema check; never re-encoded into a call. */
  arguments: z.record(z.string(), z.unknown()),
  argumentSchema: z.record(z.string(), z.unknown()),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  advertised: z.object({
    network: z.string().min(1).max(64),
    asset: z.string().min(1).max(128),
    maxAmountAtomic: z.string().regex(/^\d+$/),
  }),
  registryListed: z.boolean().optional(),
  request: RequestSchema,
});
export type DecisionContract = z.infer<typeof ContractSchema>;

const DecisionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  requestId: z.string().min(1).max(200),
  decision: z.object({
    action: z.enum(['native', 'execute', 'needs_input']),
    capabilityId: z.string().min(1).max(200).optional(),
    contract: ContractSchema.optional(),
    reason: z.string().max(2_000).optional(),
  }),
  jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** The decision parser, exposed so the shared wire fixtures are checked against
 *  the same schema production parses with rather than a copy of it. */
export function parseDecisionForTests(value: unknown): { success: boolean } {
  return { success: DecisionResponseSchema.safeParse(value).success };
}

/** One decoded challenge per resource URL, for this process only. */
export class RequirementsCache {
  private readonly entries = new Map<string, PaymentRequired>();
  get(url: string): PaymentRequired | undefined {
    return this.entries.get(url);
  }
  set(url: string, challenge: PaymentRequired): void {
    this.entries.set(url, challenge);
  }
  clear(url: string): void {
    this.entries.delete(url);
  }
}

export interface DecisionRequest {
  requestId: string;
  query: string;
  packet: Packet;
}

export interface DecisionDeps {
  ctx: CommandContext;
  baseUrl: string;
  signer: TenjinSigner;
  authorizer: SpendAuthorizer;
  cache: RequirementsCache;
  fetchImpl?: typeof fetch;
}

export type DecisionOutcome =
  | { status: 'decided'; response: DecisionResponse; amountAtomic: bigint; probed: boolean }
  /** `committedAtomic` is what a FIRST attempt already transmitted when the
   *  retry's fresh terms failed the gate; zero on an ordinary refusal. */
  | { status: 'needs_approval'; reason: string; committedAtomic: bigint }
  /** `committedAtomic` is what the ledger already counted for this attempt, so
   *  the tool can report the fee a post-transmission failure still owes. */
  | { status: 'failed'; reason: string; committedAtomic: bigint };

export async function requestDecision(
  request: DecisionRequest,
  deps: DecisionDeps,
): Promise<DecisionOutcome> {
  const url = new URL(ROUTER_PATH, deps.baseUrl).toString();
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody: {
      schemaVersion: 1,
      requestId: request.requestId,
      query: request.query,
      packet: request.packet,
    },
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  let challenge = deps.cache.get(url);
  let probed = false;
  if (challenge === undefined) {
    const probe = await httpRequest(url, options);
    if (!probe.ok) {
      return {
        status: 'failed',
        reason: fetchFailureToCliError(probe).message,
        committedAtomic: NO_FEE,
      };
    }
    if (probe.status !== 402) {
      return {
        status: 'failed',
        reason: `The router endpoint answered ${probe.status}.`,
        committedAtomic: NO_FEE,
      };
    }
    const decoded = decodeChallenge(probe);
    if (decoded === null) {
      return {
        status: 'failed',
        reason: 'The 402 carried no usable challenge.',
        committedAtomic: NO_FEE,
      };
    }
    challenge = decoded;
    probed = true;
    deps.cache.set(url, decoded);
  }

  const attempt = await payOnce(url, options, challenge, deps);
  if (attempt.status !== 'stale') return { ...attempt, probed } as DecisionOutcome;

  // One retry, from the challenge the endpoint just re-advertised, with every
  // spending check run again on the new terms and the same request id. The
  // stale attempt's amount rides along so the caller reports EVERYTHING that
  // was transmitted for this one decision, not just the attempt that answered.
  deps.cache.set(url, attempt.challenge);
  const spent = attempt.committedAtomic;
  const retried = await payOnce(url, options, attempt.challenge, deps);
  if (retried.status === 'stale') {
    return {
      status: 'failed',
      reason: 'The router endpoint keeps re-pricing this request.',
      committedAtomic: spent + retried.committedAtomic,
    };
  }
  if (retried.status === 'failed') {
    return { ...retried, committedAtomic: spent + retried.committedAtomic };
  }
  if (retried.status === 'decided') {
    return { ...retried, amountAtomic: spent + retried.amountAtomic, probed };
  }
  // `needs_approval` too: the fresh terms failing the gate does not un-transmit
  // the first authorization, and a receipt reporting zero there would tell the
  // model a call was free that the ledger has already counted.
  return { ...retried, committedAtomic: spent + retried.committedAtomic };
}

type Attempt =
  | DecisionOutcome
  /** The authorization for this attempt WAS transmitted; `committedAtomic` is
   *  what the ledger counted for it, and the retry carries it forward. */
  | { status: 'stale'; challenge: PaymentRequired; committedAtomic: bigint };

const NO_FEE = 0n;

async function payOnce(
  url: string,
  options: HttpRequestOptions,
  challenge: PaymentRequired,
  deps: DecisionDeps,
): Promise<Attempt> {
  const requirement = challenge.accepts[0];
  if (requirement === undefined) {
    deps.cache.clear(url);
    return {
      status: 'failed',
      reason: 'The router challenge advertised no payment requirements.',
      committedAtomic: NO_FEE,
    };
  }
  const amountAtomic = BigInt(requirement.amount);
  const host = new URL(url).host;

  let reservationId: string | undefined;
  try {
    reservationId = await gateSpend({
      ctx: deps.ctx,
      authorizer: deps.authorizer,
      amountAtomic,
      creator: host,
      yes: false,
      // The MCP handler has nobody to ask, so the confirm seam answers no and
      // the refusal reaches the model as `needs_approval` with the exact fix.
      confirm: async () => false,
      payeeLabel: host,
      allowlistSubject: 'this host',
      notConfirmedMessage: 'The routing fee needs approval.',
    });
  } catch (err) {
    return {
      status: 'needs_approval',
      reason: err instanceof Error ? err.message : String(err),
      committedAtomic: NO_FEE,
    };
  }

  let payment: Awaited<ReturnType<typeof buildExactPayment>>;
  try {
    payment = await buildExactPayment(challenge, deps.signer);
  } catch (err) {
    await deps.authorizer.release(reservationId);
    deps.cache.clear(url);
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      committedAtomic: NO_FEE,
    };
  }

  const paid = await httpRequest(url, { ...options, headers: payment.headers });
  const fee = payment.amountAtomic;
  if (!paid.ok) {
    await deps.authorizer.commit(reservationId, fee);
    return {
      status: 'failed',
      reason:
        'The router response was lost after the authorization was transmitted; the routing fee may have settled.',
      committedAtomic: fee,
    };
  }
  if (paid.status === 402) {
    const settlementReported = paid.header(PAYMENT_RESPONSE_HEADER) !== undefined;
    const fresh = decodeChallenge(paid);
    if (!settlementReported && fresh !== null) {
      // A fresh challenge before the handler ran means the requirements this
      // attempt was built against were stale, and the retry below signs the new
      // ones. THE FIRST AUTHORIZATION STILL COUNTS. It was transmitted, and a
      // signed EIP-3009 authorization is a bearer instrument: a 402 is the
      // counterparty's claim that it will not settle, not proof. Releasing here
      // is exactly the hole `runPay` documents at its own paid leg, where a
      // hostile seller answers 402 after each signature while `sessionBudget`
      // counts none of what it is stacking up. So this commits and hands the
      // amount to the retry, which reports the pair rather than the last one.
      await deps.authorizer.commit(reservationId, fee);
      return { status: 'stale', challenge: fresh, committedAtomic: fee };
    }
    await deps.authorizer.commit(reservationId, fee);
    return {
      status: 'failed',
      reason: settlementReported
        ? 'The routing payment did not settle; nothing was signed again.'
        : 'The router answered 402 with no usable challenge.',
      committedAtomic: fee,
    };
  }
  await deps.authorizer.commit(reservationId, fee);
  if (paid.status < 200 || paid.status >= 300) {
    return {
      status: 'failed',
      reason: `The router endpoint answered ${paid.status}.`,
      committedAtomic: fee,
    };
  }
  const parsed = DecisionResponseSchema.safeParse(paid.json);
  if (!parsed.success) {
    return {
      status: 'failed',
      reason: 'The router returned a decision this build cannot read.',
      committedAtomic: fee,
    };
  }
  return { status: 'decided', response: parsed.data, amountAtomic: fee, probed: false };
}

function decodeChallenge(response: HttpResponse): PaymentRequired | null {
  const encoded = response.header(PAYMENT_REQUIRED_HEADER);
  if (encoded === undefined) return null;
  try {
    return decodePaymentRequiredHeader(encoded);
  } catch {
    return null;
  }
}
