import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { z } from 'zod';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { HttpRequestOptions, HttpResponse } from '../lib/http';
import { gateSpend } from '../lib/spend-gate';
import type { SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import {
  buildExactPayment,
  createPayerClient,
  noPayableRequirement,
  selectPayableRequirement,
} from '../lib/x402-pay';
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

/**
 * WHAT THE BACKEND SAYS IT CHARGED, which is not what this client signed for.
 * The router settles only an executable decision: `needs_input`, `native`, an
 * unsupported task and a classifier outage are decided before settlement and
 * waived. The signed authorization still LEFT, so it stays counted as exposure;
 * this is what to report as the actual fee (2026-09-23 lookup contract).
 *
 * `reasonCode` is read as a free string on purpose. The contract enumerates
 * five values today, and a build that refused an unknown sixth would turn a
 * perfectly good decision into a failure over a label it only displays.
 */
const BillingSchema = z.object({
  settled: z.boolean(),
  amountAtomic: z.string().regex(/^\d+$/),
  asset: z.string().min(1).max(128),
  network: z.string().min(1).max(64),
  reasonCode: z.string().min(1).max(64),
});
export type DecisionBilling = z.infer<typeof BillingSchema>;

/** What stopped a non-execute outcome, in terms the host can act on. Same
 *  forward-compatibility rule as `billing`: strings, not enums. */
const DiagnosticsSchema = z.object({
  reasonCode: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  missing: z.array(z.string().max(200)).max(60),
  nextAction: z.string().max(500),
});
export type DecisionDiagnostics = z.infer<typeof DiagnosticsSchema>;

/**
 * STRICT, AT BOTH LEVELS. A non-strict object drops a field it does not know,
 * which is how `diagnostics` nested one level deeper than this build expected
 * turned every waived decision into "a decision this build cannot read": the
 * field vanished, the shape check failed, and a waived fee was booked as
 * settled. A field in the wrong place must fail loudly and name itself.
 *
 * The two repos ship together and share these fixtures, so an added field
 * fails a fixture test here before it can reach anybody's session.
 */
const DecisionResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    routerVersion: z.string().min(1).max(64),
    requestId: z.string().min(1).max(200),
    decision: z.strictObject({
      action: z.enum(['native', 'execute', 'needs_input']),
      capabilityId: z.string().min(1).max(200).optional(),
      contract: ContractSchema.optional(),
      reason: z.string().max(2_000).optional(),
      /** Required on every outcome this client cannot execute, and filed beside
       *  the decision it explains rather than beside the money, which is where
       *  the shared wire fixtures put it. */
      diagnostics: DiagnosticsSchema.optional(),
    }),
    /**
     * REQUIRED, NOT OPTIONAL. Nothing is released and there are no old clients
     * (contract amendment 2026-09-23), so a response without `billing` is a
     * protocol error rather than an older server, and this build says so instead
     * of guessing at what it was charged.
     */
    billing: BillingSchema,
    jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision.action !== 'execute' && value.decision.diagnostics === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', 'diagnostics'],
        message: 'a non-execute decision must carry diagnostics',
      });
    }
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

/**
 * THE GATE'S ANSWER, TRAVELLING AS EVIDENCE. The free prompt gate already
 * classified this turn, and sending that category with the paid decision is
 * what stops the gate and the binder contradicting each other inside one turn.
 *
 * EVIDENCE, NOT A COMMAND AND NOT PAYMENT AUTHORITY. The backend may refine or
 * reject it; the client's own spend policy remains the only thing that
 * authorizes money. It is bound to ONE lookup by `turnId` and `lookupId`, and
 * the caller that supplies it must not reuse it for a later or parallel lookup
 * (see `consumeGateHint`, which is one-shot for exactly that reason).
 */
export interface GateHint {
  /** One of the gate's eight task categories, as the hint named it. */
  category: string;
  /** The turn this category was produced in: the packet stamp. */
  turnId: string;
  /** The lookup it is evidence for. */
  lookupId: string;
}

export interface DecisionRequest {
  requestId: string;
  query: string;
  packet: Packet;
  gateHint?: GateHint;
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
  | {
      status: 'decided';
      response: DecisionResponse;
      /** WHAT WAS AUTHORIZED AND TRANSMITTED, always. A signed EIP-3009
       *  authorization is a bearer instrument, and a body saying "no charge"
       *  does not revoke it, so this is what the session budget counts. */
      amountAtomic: bigint;
      /** WHAT THE BACKEND SAYS IT ACTUALLY TOOK: `billing.amountAtomic` when it
       *  settled, zero when it waived, and the full exposure for a backend that
       *  sends no `billing` at all, which is today's conservative reporting. */
      settledAtomic: bigint;
      probed: boolean;
    }
  /** `committedAtomic` is what a FIRST attempt already transmitted when the
   *  retry's fresh terms failed the gate; zero on an ordinary refusal. */
  | { status: 'needs_approval'; reason: string; committedAtomic: bigint }
  /** `committedAtomic` is what the ledger already counted for this attempt, so
   *  the tool can report the fee a post-transmission failure still owes.
   *  `errorCode` is the backend's own stable code when its body carried one. */
  | { status: 'failed'; reason: string; committedAtomic: bigint; errorCode?: string };

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
      ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
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
    // The stale attempt carries no billing of its own: a 402 is not a statement
    // that nothing settled, so its amount counts as exposure AND as settled.
    return {
      ...retried,
      amountAtomic: spent + retried.amountAtomic,
      settledAtomic: spent + retried.settledAtomic,
      probed,
    };
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
  // ONE SELECTION, so the CHECKED entry is the SIGNED entry. The fee gate, the
  // reservation and the ledger all run on the requirement chosen here, and that
  // same requirement goes to `buildExactPayment` as `only`, exactly as `runPay`
  // and `runBuy` do. Pricing `accepts[0]` and then letting the builder re-select
  // through the SDK's canonical-USDC policy meant a router 402 whose first entry
  // sits on an unsupported network or asset had `maxAutoSpend`, the confirm and
  // the ledger evaluated on one entry while the authorization carried another.
  const { core } = createPayerClient(() => deps.signer);
  const requirement = selectPayableRequirement(core, challenge);
  if (requirement === undefined) {
    deps.cache.clear(url);
    return {
      status: 'failed',
      reason: noPayableRequirement(challenge.accepts).message,
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
    payment = await buildExactPayment(challenge, deps.signer, requirement);
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
  const parsed =
    paid.status >= 200 && paid.status < 300 ? DecisionResponseSchema.safeParse(paid.json) : null;
  // THE EXPOSURE IS COMMITTED WHATEVER THE BODY SAYS; the settled amount is the
  // backend's own claim about what it took, clamped by what this client
  // actually authorized. A response cannot raise a charge above the signature,
  // and a waived decision reports zero settled against the same exposure.
  const settled = parsed?.success === true ? settledAmount(parsed.data.billing, fee) : fee;
  await deps.authorizer.commit(reservationId, fee, { settledAtomic: settled });
  if (parsed === null) {
    const named = errorOf(paid.json);
    return {
      status: 'failed',
      // The backend's own code and message, never a bare status line: a typed
      // refusal the host could act on was arriving as "answered 400".
      reason:
        named === null
          ? `The router endpoint answered ${paid.status}.`
          : `The router endpoint answered ${paid.status} (${named.code}): ${named.message}`,
      committedAtomic: fee,
      ...(named !== null ? { errorCode: named.code } : {}),
    };
  }
  if (!parsed.success) {
    return {
      status: 'failed',
      reason: 'The router returned a decision this build cannot read.',
      committedAtomic: fee,
    };
  }
  return {
    status: 'decided',
    response: parsed.data,
    amountAtomic: fee,
    settledAtomic: settled,
    probed: false,
  };
}

/**
 * What actually settled, from a response that parsed and therefore carries
 * `billing`. A body claiming MORE than the signature authorized is clamped to
 * it: the signature is the ceiling on what can move, whatever the body says.
 * A response that did not parse never reaches here, and its exposure is
 * committed in full, which is the conservative reading.
 */
function settledAmount(billing: DecisionBilling, exposure: bigint): bigint {
  if (!billing.settled) return NO_FEE;
  const claimed = BigInt(billing.amountAtomic);
  return claimed < exposure ? claimed : exposure;
}

/** `{ error: { code, message } }`, the envelope every Tenjin route answers a
 *  refusal with. Anything else reads as no code rather than as a guess. */
function errorOf(body: unknown): { code: string; message: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) return null;
  const text = typeof message === 'string' ? message.slice(0, 500) : '';
  return { code, message: text };
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
