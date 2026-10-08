import { z } from 'zod';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { FetchJsonFailure, HttpRequestOptions, HttpResult } from '../lib/http';
import type { CommandContext } from '../context';
import type { Packet } from './context';

/**
 * `POST /api/x402-router`: ONE DECISION PER LOOKUP. On the free path it costs
 * nothing. Inside `tenjin mcp`, while the server answers its paid path, the
 * same body goes to that path through the stock x402 client
 * ({@link DecisionRoute}, `routing-payer.ts`); a call that path cannot take
 * falls back to the free path. The rest of this note describes the free path,
 * which is unchanged.
 *
 * The routing decision costs nothing and nobody signs for it. The hook asks for
 * it from the user's own words, the backend answers with what it would do and
 * what the provider charges, and the only payment on the wire is the one
 * `runPay` makes to that provider. That deletes the router fee and everything
 * built to carry it: the 402 probe, the requirements cache, the stale-quote
 * retry, the settlement accounting and one Base settlement of about 1.5 s from
 * every paid lookup.
 *
 * The bounded packet travels with the hook request and the backend keeps it
 * against the decision id until that id expires. What this client keeps is
 * each offer's spec, by its id (`specs.ts`).
 */

export const ROUTER_PATH = '/api/x402-router';

/**
 * The request the server builds and this client sends verbatim. Query assembly,
 * body encoding and header choice are the server's; what stays here is every
 * check that decides whether to send it at all.
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

const ContractSchema = z.object({
  /** Flat, for display and for the result check; never re-encoded into a call:
   *  the server built `request` from them and this client sends that verbatim. */
  arguments: z.record(z.string(), z.unknown()).optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  request: RequestSchema,
});
export type DecisionContract = z.infer<typeof ContractSchema>;

/**
 * What stopped an outcome this client cannot execute, in terms the host can act
 * on: a stable reason code, the stage that stopped, the fields or scope choices
 * the user can supply, and one concrete next action.
 */
const DiagnosticsSchema = z.object({
  reasonCode: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  missing: z.array(z.string().max(200)).max(60),
  nextAction: z.string().max(500),
});
export type DecisionDiagnostics = z.infer<typeof DiagnosticsSchema>;

/**
 * ONE VARIANT PER ANSWER, DISCRIMINATED ON THE ACTION. Optional fields made
 * every shape legal: an `execute` with no contract parsed and came back to the
 * host as a routine `needs_input`, a non-execute with no diagnostics parsed
 * with nothing to act on, and a hook answer carrying a contract parsed as
 * though the hook had quoted a price. Each of those is drift the shared
 * fixtures exist to catch, so each is now a parse failure that names itself.
 *
 * The two calls ask different questions and get different answers, so they get
 * different parsers. The HOOK asks whether a paid lookup is worth offering: an
 * id, or a reason it is not. The TOOL asks for the decision: the capability,
 * its price and the contract together, so a caller cannot approve one offer and
 * receive another.
 */
const IdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .describe(
    'The turn id, an OPAQUE HANDLE: it is the one piece of server text this ' +
      'client puts in a model-facing line, so the alphabet is pinned here ' +
      'rather than escaped later.',
  );

/** Every non-execute answer carries these, beside the action they explain. */
const RefusedSchema = z.strictObject({
  reason: z.string().max(2_000).optional(),
  diagnostics: DiagnosticsSchema,
});

/**
 * WHAT THE SERVICE IS, AND WHAT IT DOES. The hook answer used to be an id and
 * nothing else, so the line the host injected could only say "a paid lookup is
 * available", which a model follows 8 to 20 times in 40 where a line naming the
 * task and the service is followed 40 in 40. The gate knows which capability
 * serves the category it chose, so it now says so; the CONTRACT is still not
 * here, because the task the host will run does not exist yet.
 */
const CapabilityFields = {
  capabilityId: z.string().min(1).max(200),
  category: z.string().min(1).max(64),
  /** The service's own name, not the x402 reseller in front of it. */
  provider: z.string().min(1).max(120),
  capabilityDescription: z.string().min(1).max(500),
  /** What the provider charges, atomic USDC. The `request` tool refuses a live
   *  402 above it; `gateSpend` still caps the amount actually signed. */
  providerPriceAtomic: z.string().regex(/^\d+$/),
};

/**
 * STRUCTURE, NEVER WORDING. A hint lands in the model's context verbatim, so
 * its shape is checked the way the id's alphabet is: one line, no control
 * characters, and it has to be the call it claims to be, naming the id this
 * same answer carries. A hint that fails any of these is a protocol error and
 * the turn falls back to the generic line; nothing here rewrites a word of a
 * hint that passes. Both offering arms, `execute` and `discovered`, hold it.
 */
function checkHint(decision: { id: string; hint: string }, ctx: z.RefinementCtx): void {
  if (/[\p{Cc}\p{Cf}]/u.test(decision.hint)) {
    ctx.addIssue({ code: 'custom', path: ['hint'], message: 'a hint is one plain line' });
  }
  if (!decision.hint.includes('request({')) {
    ctx.addIssue({ code: 'custom', path: ['hint'], message: 'a hint names the call to make' });
  }
  if (!decision.hint.includes(decision.id)) {
    ctx.addIssue({
      code: 'custom',
      path: ['hint'],
      message: "a hint carries this answer's own id",
    });
  }
}

/**
 * A PAY-PER-CALL SERVICE NOBODY CURATED. When no capability in the catalog fits
 * but a listed x402 service could do the step, the server names that one
 * service: who sells it, where, for how much, and the input it takes. The
 * candidate is the seller's own listing, so every field is data for the host
 * to judge, never an instruction; the host builds the `input` and the tool
 * call pays through the same `runPay` path and caps as a curated lookup.
 */
const DiscoveredCandidateSchema = z.strictObject({
  source: z.string().min(1).max(64),
  provider: z.string().min(1).max(120),
  url: z.string().min(1).max(2_048),
  method: z.enum(['GET', 'POST']),
  description: z.string().max(500),
  providerPriceAtomic: z.string().regex(/^\d+$/),
  network: z.string().min(1).max(64),
  payTo: z.string().min(1).max(200),
  input: z.strictObject({
    location: z.enum(['body', 'query']),
    schema: z.record(z.string(), z.unknown()),
  }),
});

/**
 * A REQUEST SPEC: the offered service's real contract, sent beside the line only
 * because this build asks for it (`accepts: ["spec"]`). The hook stores it by
 * the offer's id; `request({id})` shows it and `request({id, input})` fills its
 * request and pays the provider directly, with no second decision. Every field
 * is the server's, and so is checked like the rest of the answer: the payee and
 * price still meet the live 402 and the spend policy in `runPay`.
 */
export const ToolSpecSchema = z.strictObject({
  capabilityId: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  priceAtomic: z.string().regex(/^\d+$/),
  priceVaries: z.boolean(),
  maxAmountAtomic: z.string().regex(/^\d+$/),
  payTo: z.string().min(1).max(200),
  network: z.string().min(1).max(64),
  asset: z.string().min(1).max(200),
  request: z.strictObject({
    method: z.enum(['GET', 'POST']),
    url: z.string().min(1).max(2_048),
    fields: z.record(z.string(), z.enum(['path', 'query', 'body'])),
    location: z.enum(['query', 'body']),
  }),
  input: z.record(z.string(), z.unknown()),
  pinned: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).optional(),
  returns: z.string().min(1).max(200).optional(),
  returnsExample: z.unknown().optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  /** The fields the result promises (type, properties, items, required). The
   *  agent is handed only these; the whole body is saved to a file. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const OfferSpecSchema = ToolSpecSchema.extend({ id: IdSchema });
export type OfferSpec = z.infer<typeof OfferSpecSchema>;

/** One spec per service the line names: the offer and any alternative. */
const SpecsSchema = z.array(OfferSpecSchema).min(1).max(4).optional();

/** The same answer on both calls: the hook's offer, and the tool's fallback
 *  when a query with no id found no curated capability. */
const DiscoveredSchema = z
  .strictObject({
    action: z.literal('discovered'),
    id: IdSchema,
    candidate: DiscoveredCandidateSchema,
    /** THE LINE, FINISHED, as on `execute`: it carries the seller's
     *  description and the input it takes. */
    hint: z.string().min(1).max(2_000),
    specs: SpecsSchema,
  })
  .superRefine(checkHint);

const HookDecisionSchema = z.discriminatedUnion('action', [
  z
    .strictObject({
      action: z.literal('execute'),
      id: IdSchema,
      ...CapabilityFields,
      /** The x402 URL a lookup would pay, for the line the server writes. */
      endpoint: z.string().min(1).max(2_048),
      /** What to pass in `query`, in the service's own terms. */
      usage: z.string().min(1).max(300),
      /**
       * THE LINE, FINISHED. The server writes it with the real id in it and, on a
       * native call, the exact search or URL that was denied. The client injects
       * it and composes nothing, which is why there is no hint builder here any
       * more: two sides writing the same sentence is how they drift. The same
       * bound as a discovered line's.
       */
      hint: z.string().min(1).max(2_000),
      specs: SpecsSchema,
    })
    .superRefine(checkHint),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

const ToolDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('execute'),
    ...CapabilityFields,
    contract: ContractSchema,
  }),
  /**
   * A query with no id, answered with the spec of the service the server
   * picked under a fresh `id`: kept like a hook's, and never run in the same
   * call. `hint` is the line, with the skeleton of the next call:
   * `request({id, input: {...}})` with the required fields. `input` is what a
   * router from before the binder's removal still sends on a bound pick: it
   * is accepted so that answer parses, and never read, so it never runs.
   */
  z
    .strictObject({
      action: z.literal('spec'),
      id: IdSchema,
      spec: ToolSpecSchema,
      hint: z.string().min(1).max(2_000),
      input: z.record(z.string(), z.unknown()).optional(),
    })
    .superRefine(checkHint),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

function envelope<T extends z.ZodTypeAny>(decision: T) {
  return z.strictObject({
    schemaVersion: z.literal(1),
    routerVersion: z.string().min(1).max(64),
    decision,
    /** A plain sentence about the CALL, such as an id that had expired. Never a
     *  failure: the decision beside it ran anyway. */
    note: z.string().max(500).optional(),
    jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
  });
}

const HookResponseSchema = envelope(HookDecisionSchema);
const ToolResponseSchema = envelope(ToolDecisionSchema);

export type HookResponse = z.infer<typeof HookResponseSchema>;
export type ToolResponse = z.infer<typeof ToolResponseSchema>;
export type HookDecision = HookResponse['decision'];
export type ToolDecision = ToolResponse['decision'];

/** Which call this is, and therefore which answer is legal for it. */
export type CallKind = 'hook' | 'tool';

/**
 * What this client can act on beyond the curated answers, sent on both calls.
 * `discovered` is Tenjin's reviewed list of third-party services, on for every
 * build that parses it; the server answers that arm only to a request that
 * lists it, so an older build never sees one. `spec` asks for each offered
 * service's request spec beside its line, and for the picked service's spec in
 * place of a decision on a query with no id, which only a build that parses
 * them can take: the decision schemas are strict. `bazaar` widens discovery
 * to the open Bazaar and is sent only while `experimental.bazaar` is on.
 */
export const CLIENT_ACCEPTS: readonly string[] = ['discovered', 'spec'];
export const BAZAAR_ACCEPT = 'bazaar';

/** The `accepts` this build sends, with the open Bazaar or without it. */
export function acceptsFor(bazaar: boolean): string[] {
  return bazaar ? [...CLIENT_ACCEPTS, BAZAAR_ACCEPT] : [...CLIENT_ACCEPTS];
}

/**
 * The exact body the hook call sends, spelled once and pinned to the shared
 * fixtures. The route reads it with a strict object, so an extra field is a
 * 400, and a 400 is a turn with no hint.
 *
 * ONE BODY FOR BOTH HOOKS. Which hook is asking is not a field: the route reads
 * it from `packet.pendingCall`, which the native hook sets and the prompt hook
 * does not. A `source` beside the packet was the `/prepare` route's shape, and
 * that route is gone. `sessionId` is the harness's own session id, which the
 * server uses only so one session is not offered the same discovered service
 * twice.
 */
export function buildHookBody(
  packet: Packet,
  extras: { sessionId?: string; accepts?: readonly string[] } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    ...(extras.accepts !== undefined ? { accepts: [...extras.accepts] } : {}),
    packet,
  };
}

/** The exact body the tool call sends. `id` is the offer the query is for,
 *  sent only for an offer with no spec kept; `gateHint` is evidence, never
 *  authority. */
export function buildToolBody(request: {
  query?: string;
  id?: string;
  gateHint?: GateHint;
  accepts?: readonly string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
    ...(request.accepts !== undefined ? { accepts: [...request.accepts] } : {}),
  };
}

/** The parsers, exposed so the shared wire fixtures are checked against the
 *  same schemas production parses with rather than against a copy of them. */
export function parseForTests(kind: CallKind, value: unknown): { success: boolean } {
  const schema = kind === 'hook' ? HookResponseSchema : ToolResponseSchema;
  return { success: schema.safeParse(value).success };
}

/**
 * The gate's own reading of this turn, travelling as EVIDENCE for the lookup it
 * was produced for. The backend may refine or reject it, and it authorizes no
 * money: the local spend policy does that. Optional on both call forms.
 */
export interface GateHint {
  category: string;
  turnId: string;
  lookupId: string;
}

export interface DecisionDeps {
  ctx: CommandContext;
  baseUrl: string;
  /** `experimental.bazaar`: add {@link BAZAAR_ACCEPT}, so a service from the
   *  open Bazaar may come back. Off by default: curated and the Tenjin list. */
  acceptsBazaar?: boolean;
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
  /** The paid path, when `tenjin mcp` takes it: the body goes to `path` and is
   *  sent by `send`, which pays the routing fee with the stock x402 client.
   *  Absent is the free path. */
  route?: DecisionRoute;
}

/** How a routing call reaches the paid path. `send` throws
 *  {@link RouteSkipped} when it has no paid answer for the call, which then
 *  takes the free path. */
export interface DecisionRoute {
  path: string;
  send: (url: string, options: HttpRequestOptions) => Promise<HttpResult>;
}

/** The paid path gave this call no answer: the wallet locked, low or over
 *  its spend limits, the channel busy, or the payment failed. */
export class RouteSkipped extends Error {
  /** `unreached`: the paid call could not reach the router
   *  ({@link isUnreachable}), so the free path, on the same host, is not
   *  tried and the call reads as that transport failure. */
  constructor(
    readonly why: string,
    readonly unreached?: FetchJsonFailure,
  ) {
    super(`routing fee not paid: ${why}`);
  }
}

/** Another session's call was in flight on the wallet's routing channel. */
export const CHANNEL_BUSY = 'channel_busy';
/** The server answered no paid path. */
export const PAID_PATH_ABSENT = 'paid_path_absent';
/** The paid call got no answer, a refused payment or a server error. */
export const PAYMENT_FAILED = 'payment_failed';

export type DecisionOutcome<T> =
  /** `freePath`: the paid path skipped the call for this reason and it went
   *  to the free path instead, unpaid. */
  | { status: 'decided'; decision: T; freePath?: string }
  /** On the free path nothing was paid and nothing could be, so a failure here
   *  costs the turn a routing answer and nothing else. */
  | {
      status: 'failed';
      reason: string;
      errorCode?: string;
      freePath?: string;
      /** The router could not be reached at all ({@link isUnreachable}). */
      unreachable?: true;
    }
  /** The paid path gave no answer ({@link RouteSkipped}) and no time was left
   *  for the free path: the native tool runs. */
  | { status: 'skipped'; why: string };

/**
 * ONE FREE CALL, IN TWO FORMS. The hook sends `{ packet }`: the backend runs
 * the gate, and on `execute` stores that packet under an id and answers with
 * each offered service's spec. The tool sends `{ query }`, which the backend
 * answers with the spec of the service its gate picks, or `{ query, id }` for
 * the free docs offer, which has no spec and is bound from the query. Every
 * provider call is built here, from a spec, or for the docs lookup by the
 * backend from the query.
 */
export async function requestDecision(
  kind: 'hook',
  request: { packet: Packet; sessionId?: string },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse>>;
export async function requestDecision(
  kind: 'tool',
  request: { query: string; id?: string; gateHint?: GateHint },
  deps: DecisionDeps,
): Promise<DecisionOutcome<ToolResponse>>;
export async function requestDecision(
  kind: CallKind,
  request: {
    query?: string;
    packet?: Packet;
    sessionId?: string;
    id?: string;
    gateHint?: GateHint;
  },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  const url = new URL(deps.route?.path ?? ROUTER_PATH, deps.baseUrl).toString();
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody:
      kind === 'hook'
        ? buildHookBody(request.packet as Packet, {
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true),
          })
        : buildToolBody({
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.id !== undefined ? { id: request.id } : {}),
            ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true),
          }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const started = Date.now();
  const schema = kind === 'hook' ? HookResponseSchema : ToolResponseSchema;
  let response: HttpResult;
  try {
    response = await (deps.route?.send ?? httpRequest)(url, options);
  } catch (err) {
    if (!(err instanceof RouteSkipped)) throw err;
    if (err.unreached !== undefined) return readDecision(err.unreached, schema);
    const left = options.timeoutMs - (Date.now() - started);
    if (left <= 0) return { status: 'skipped', why: err.why };
    // A CALL THE PAID PATH COULD NOT TAKE STILL ROUTES, on the free path,
    // unpaid, inside what is left of its budget, and says why.
    response = await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      ...options,
      timeoutMs: left,
    });
    const free = readDecision(response, schema);
    // A failure here ran on what a paid attempt left of the budget, so it says
    // nothing about the router being down: it never starts the backoff.
    if (free.status === 'failed') {
      return {
        status: 'failed',
        reason: free.reason,
        ...(free.errorCode !== undefined ? { errorCode: free.errorCode } : {}),
        freePath: err.why,
      };
    }
    return free.status === 'skipped' ? free : { ...free, freePath: err.why };
  }
  return readDecision(response, schema);
}

/** How a call run from a request spec ended, for the server's offer-to-call
 *  count. No text: the id, the outcome, the provider's status and the time. */
export interface SpecOutcome {
  id: string;
  status: 'fulfilled' | 'unverified' | 'failed' | 'needs_approval';
  httpStatus?: number;
  ms?: number;
}

/** The outcome report's own deadline: it is telemetry and never holds a result. */
export const OUTCOME_TIMEOUT_MS = 3_000;

/**
 * TELL THE SERVER A SPEC WAS USED. The client called and paid the provider
 * itself, so this is the only word the server gets that its offer was taken.
 * Never throws and never waits on anything the caller needs: a lost report
 * costs one count.
 */
export async function reportSpecOutcome(
  outcome: SpecOutcome,
  deps: Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl'>,
): Promise<void> {
  try {
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: OUTCOME_TIMEOUT_MS,
      blockRedirects: true,
      jsonBody: buildOutcomeBody(outcome),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    // Telemetry only.
  }
}

/** The exact body of an outcome report, pinned to the shared fixtures. */
export function buildOutcomeBody(outcome: SpecOutcome): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: outcome.id,
    status: outcome.status,
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.ms !== undefined ? { ms: Math.max(0, Math.round(outcome.ms)) } : {}),
  };
}

function readDecision<T extends z.ZodTypeAny>(
  response: HttpResult,
  schema: T,
): DecisionOutcome<z.infer<T>> {
  // A transport failure says its own reason; nothing was paid either way,
  // because there is nothing to pay for on this route.
  if (!response.ok) {
    return {
      status: 'failed',
      reason: fetchFailureToCliError(response).message,
      ...(isUnreachable(response) ? { unreachable: true as const } : {}),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    const named = errorOf(response.json);
    return {
      status: 'failed',
      // The backend's own code and message, never a bare status line: a typed
      // refusal the host could act on was arriving as "answered 400".
      reason:
        named === null
          ? `The router endpoint answered ${response.status}.`
          : `The router endpoint answered ${response.status} (${named.code}): ${named.message}`,
      ...(named !== null ? { errorCode: named.code } : {}),
    };
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return { status: 'failed', reason: 'The router returned a decision this build cannot read.' };
  }
  return { status: 'decided', decision: parsed.data as z.infer<T> };
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

/** A dropped socket, which a fresh connection usually gets past. */
const RESET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET']);

/**
 * A ROUTER THAT CANNOT BE REACHED: the transport named the layer that refused
 * the connection (DNS, TLS, a refused connection, a proxy refusing the tunnel)
 * and no status came back. Never the call's own timeout: that is the gate's
 * few seconds, and a slow decision or a cold start must not take the router
 * away from every session. Never a status, even with a body that failed to
 * read, and never a reset socket, which the free path retries on a fresh one.
 */
export function isUnreachable(failure: FetchJsonFailure): boolean {
  return (
    failure.kind === 'network' &&
    failure.status === undefined &&
    failure.transport !== undefined &&
    !RESET_CODES.has(failure.transport.code ?? '')
  );
}
