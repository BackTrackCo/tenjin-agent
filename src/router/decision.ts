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
 * Both repos ship together and share the wire fixtures, so a field added on one
 * side fails a fixture test before it can reach a session.
 */
const DecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  /** The decision id: the FAST path, never the accurate one. */
  id: z.string().min(1).max(200).optional(),
  action: z.enum(['native', 'execute', 'needs_input']),
  /** One plain line naming what the decision does, for the result. */
  description: z.string().max(300).optional(),
  /** Who would be paid, for that same line. */
  provider: z.string().max(120).optional(),
  /** What the provider charges, atomic USDC. DISPLAY ONLY: the only cap on a
   *  payment is the local spend policy, never a price a server advertised. */
  providerPriceAtomic: z.string().regex(/^\d+$/).optional(),
  category: z.string().max(64).optional(),
  /** Present when the backend bound the call before answering; otherwise the
   *  tool fetches it by id. */
  contract: ContractSchema.optional(),
  diagnostics: DiagnosticsSchema.optional(),
  jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** The parser, exposed so the shared wire fixtures are checked against the
 *  same schema production parses with rather than against a copy of it. */
export function parseDecisionForTests(value: unknown): { success: boolean } {
  return { success: DecisionSchema.safeParse(value).success };
}

export interface DecisionDeps {
  ctx: CommandContext;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
}

export type DecisionOutcome<T = Decision> =
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
  request: { query?: string; packet?: Packet; id?: string },
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
