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
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().min(1).max(16_384),
  /** Flat, for display and for the schema check; never re-encoded into a call. */
  arguments: z.record(z.string(), z.unknown()).optional(),
  argumentSchema: z.record(z.string(), z.unknown()).optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  /** What the capability says it costs. DISPLAY ONLY: the amount actually
   *  signed is what `gateSpend` caps, and a price a server states is not a
   *  ceiling anyone holds it to. */
  advertised: z
    .object({
      network: z.string().min(1).max(64),
      asset: z.string().min(1).max(128),
      maxAmountAtomic: z.string().regex(/^\d+$/),
    })
    .optional(),
  registryListed: z.boolean().optional(),
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
 * STRICT, so a field in the wrong place fails loudly and names itself rather
 * than being dropped into a shape check that then blames the whole response.
 * Three divergences have cost a round trip each, which is why both repos parse
 * the same fixtures with their own parser rather than a shared one.
 *
 * ONE SHAPE, TWO ANSWERS. The hook's call gets `{action:'execute', id}` and
 * nothing else, because at gate time there is no capability, no price and no
 * contract to name. The tool's call gets the decision: the capability, its
 * price and the contract together, so a caller cannot approve one offer and
 * receive another. Every non-execute answer carries `diagnostics`, nested
 * inside `decision` beside the action it explains.
 */
const DecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  decision: z.strictObject({
    action: z.enum(['native', 'execute', 'needs_input']),
    /**
     * The turn id, and an OPAQUE HANDLE by construction. It is the one piece of
     * server text this client puts in a model-facing line, so the shape is
     * checked here rather than escaped later: the backend mints uuids, and
     * anything outside this alphabet is a protocol error that costs the turn
     * its hint (the hook then says to call `request` with the query alone).
     */
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
    capabilityId: z.string().min(1).max(200).optional(),
    category: z.string().max(64).optional(),
    /** One plain line naming the capability and who serves it. */
    description: z.string().max(300).optional(),
    /** What the provider charges, atomic USDC. Display only. */
    providerPriceAtomic: z.string().regex(/^\d+$/).optional(),
    reason: z.string().max(2_000).optional(),
    contract: ContractSchema.optional(),
    diagnostics: DiagnosticsSchema.optional(),
  }),
  /** A plain sentence about the call itself, such as an id that had expired.
   *  Never a failure: the decision beside it still ran. */
  note: z.string().max(500).optional(),
  jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
});
export type DecisionResponse = z.infer<typeof DecisionSchema>;
export type Decision = DecisionResponse['decision'];

/** The parser, exposed so the shared wire fixtures are checked against the
 *  same schema production parses with rather than against a copy of it. */
export function parseDecisionForTests(value: unknown): { success: boolean } {
  return { success: DecisionSchema.safeParse(value).success };
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

export type DecisionOutcome<T = DecisionResponse> =
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
  request: { query?: string; packet?: Packet; id?: string; gateHint?: GateHint },
  deps: DecisionDeps,
): Promise<DecisionOutcome> {
  const url = new URL(ROUTER_PATH, deps.baseUrl).toString();
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody: {
      schemaVersion: 1,
      ...(request.query !== undefined ? { query: request.query } : {}),
      ...(request.packet !== undefined ? { packet: request.packet } : {}),
      ...(request.id !== undefined ? { id: request.id } : {}),
      ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
    },
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return readDecision(await httpRequest(url, options), DecisionSchema);
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
