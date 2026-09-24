import { z } from 'zod';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { HttpRequestOptions, HttpResult } from '../lib/http';
import type { CommandContext } from '../context';
import type { Packet } from './context';

/**
 * `POST /api/x402-router`: ONE FREE DECISION PER LOOKUP.
 *
 * The routing decision costs nothing and nobody signs for it. The hook asks for
 * it from the user's own words, the backend answers with what it would do and
 * what the provider charges, and the only payment on the wire is the one
 * `runPay` makes to that provider. That deletes the router fee and everything
 * built to carry it: the 402 probe, the requirements cache, the stale-quote
 * retry, the settlement accounting and one Base settlement of about 1.5 s from
 * every paid lookup.
 *
 * NOTHING IS STORED LOCALLY. The bounded packet travels with the request and
 * the backend keeps it against the decision id until that id expires, which is
 * how `request({query})` reaches the same calibrated input with no session
 * file, no timestamp latch and no guess about which window this process serves.
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
       * more: two sides writing the same sentence is how they drift.
       */
      hint: z.string().min(1).max(1_000),
    })
    .superRefine((decision, ctx) => {
      // STRUCTURE, NEVER WORDING. This line lands in the model's context
      // verbatim, so the shape is checked the way the id's alphabet is: one
      // line, no control characters, and it has to be the call it claims to be,
      // naming the id this same answer carries. A hint that fails any of these
      // is a protocol error and the turn falls back to the generic line; nothing
      // here rewrites a word of a hint that passes.
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
    }),
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

const ToolDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('execute'),
    ...CapabilityFields,
    contract: ContractSchema,
  }),
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
 * The exact body the hook call sends, spelled once and pinned to the shared
 * fixtures. The route reads it with a strict object, so an extra field is a
 * 400, and a 400 is a turn with no hint.
 *
 * ONE BODY FOR BOTH HOOKS. Which hook is asking is not a field: the route reads
 * it from `packet.pendingCall`, which the native hook sets and the prompt hook
 * does not. A `source` beside the packet was the `/prepare` route's shape, and
 * that route is gone.
 */
export function buildHookBody(packet: Packet): Record<string, unknown> {
  return { schemaVersion: 1, packet };
}

/** The exact body the tool call sends. `id` is the turn whose packet decides
 *  with this query; `gateHint` is evidence, never authority. */
export function buildToolBody(request: {
  query: string;
  id?: string;
  gateHint?: GateHint;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    query: request.query,
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
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
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
}

export type DecisionOutcome<T> =
  | { status: 'decided'; decision: T }
  /** Nothing was paid and nothing could be: the endpoint is free, so a failure
   *  here costs the turn a routing answer and nothing else. */
  | { status: 'failed'; reason: string; errorCode?: string };

/**
 * ONE FREE CALL, IN TWO FORMS. The hook sends `{ packet }`: the backend runs
 * the gate, and on `execute` stores that packet under an id. The tool sends
 * `{ query, id? }`: the backend makes THE decision from that query plus the
 * packet it stored, and answers with the contract to run.
 *
 * The tool never sends a packet of its own. The turn's context lives on the
 * backend against the id, and the query the model wrote is what the routing
 * corpus is calibrated against: 55 of 56 for query plus packet, 53 of 56 for
 * the raw prompt, measured on jev-1.13.0.
 */
export async function requestDecision(
  kind: 'hook',
  request: { packet: Packet },
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
    id?: string;
    gateHint?: GateHint;
  },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  const url = new URL(ROUTER_PATH, deps.baseUrl).toString();
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody:
      kind === 'hook'
        ? buildHookBody(request.packet as Packet)
        : buildToolBody({
            query: request.query as string,
            ...(request.id !== undefined ? { id: request.id } : {}),
            ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
          }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return readDecision(
    await httpRequest(url, options),
    kind === 'hook' ? HookResponseSchema : ToolResponseSchema,
  );
}

function readDecision<T extends z.ZodTypeAny>(
  response: HttpResult,
  schema: T,
): DecisionOutcome<z.infer<T>> {
  // A transport failure says its own reason; nothing was paid either way,
  // because there is nothing to pay for on this route.
  if (!response.ok) return { status: 'failed', reason: fetchFailureToCliError(response).message };
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
