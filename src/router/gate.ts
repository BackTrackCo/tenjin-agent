import { z } from 'zod';
import type { Packet } from './context';

/**
 * The free gate, `POST /api/x402-router/prepare`. One question: would a catalog
 * capability help this prompt or this native call? The answer carries an action
 * and, at most, one line of guidance. Nothing executable comes back, nothing is
 * signed, and the wallet is never opened on this path.
 *
 * THE HINT IS SERVER TEXT ENTERING THE SESSION, so it is checked against a
 * fixed shape before it is emitted: one short line naming one of the eight task
 * categories and ending in the standard call-to-action. A hint that does not
 * match is dropped and the turn continues with no injection at all.
 */

export const GATE_PATH = '/api/x402-router/prepare';
/**
 * The hook's whole budget is 5 s (the timeout `install` writes). Stdin waits up
 * to 1 s of it, so the gate gets 3.5 s and the two together still leave 500 ms
 * for node's boot and the transcript read; `wire.test.ts` pins the sum.
 *
 * AN ABORT HERE IS A LOST HINT, not a lost turn: `askGate` maps it to `null`,
 * the turn proceeds with nothing injected, and the hint is the only thing that
 * makes the model reach for `request`. One of four live prompts was swallowed
 * that way at a 1.5 s abort against a backend measured at 0.4 to 0.5 s, so the
 * gate now holds the slack the harness budget was already leaving unused.
 */
export const GATE_TIMEOUT_MS = 3_500;

/** The task vocabulary the gate answers in. Providers are never named. */
export const CATEGORIES = [
  'web research',
  'read an exact page',
  'crypto price quote',
  'company profile by domain',
  'company match by name or social URL',
  'email verification',
  'person enrichment',
  'computation',
] as const;

const MAX_HINT_CHARS = 300;
const HINT_TAIL = 'and wait for its result.';

const GateResponseSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  action: z.enum(['native', 'execute', 'needs_input']),
  hint: z.string().max(1_000).optional(),
});
export type GateAction = z.infer<typeof GateResponseSchema>['action'];

export interface GateAnswer {
  action: GateAction;
  routerVersion: string;
  /** Present only when it passed {@link isWellFormedHint}. */
  hint?: string;
  /** The one task category the hint named, present exactly when the hint is.
   *  It travels to the paid decision as evidence for that same lookup. */
  category?: string;
}

export function isWellFormedHint(hint: string): boolean {
  return categoryOf(hint) !== undefined;
}

/**
 * The ONE category a well-formed hint names, or undefined for a hint this
 * build will not emit. Shape and category are one question, not two: the hint
 * is well formed exactly when exactly one category is in it, and that category
 * is what travels to the paid decision as evidence.
 */
export function categoryOf(hint: string): string | undefined {
  if (hint.length === 0 || hint.length > MAX_HINT_CHARS) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(hint)) return undefined;
  if (/[`<>*_[\]{}\\]/.test(hint)) return undefined;
  if (!hint.includes('Call request')) return undefined;
  if (!hint.endsWith(HINT_TAIL)) return undefined;
  const lowered = hint.toLowerCase();
  const named = CATEGORIES.filter((category) => lowered.includes(category));
  return named.length === 1 ? named[0] : undefined;
}

export interface GateRequest {
  source: 'prompt' | 'native';
  /** The pending native call travels INSIDE this; see {@link buildGateBody}. */
  packet: Packet;
}

/**
 * The exact body the gate takes. The server reads it with a STRICT object of
 * `schemaVersion`, `source` and `packet` (tenjin `lib/x402-router/wire.ts`), so
 * a pending call sent beside the packet is a 400 and, because `askGate` maps a
 * non-200 to `null` and a null answer allows, a silently dead native gate.
 * Spelled here and pinned by a fixture both sides share.
 */
export function buildGateBody(request: GateRequest): Record<string, unknown> {
  return { schemaVersion: 1, source: request.source, packet: request.packet };
}

export interface GateDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called with WHY the answer was null. The callers are silent by contract,
   *  so this is the only place a dead gate can say anything at all. */
  onFailure?: (detail: string) => void;
}

/**
 * Ask the gate. `null` is every failure there is (an unreachable backend, a
 * non-200, an unparseable or ill-shaped body, a timeout): the callers treat a
 * silent gate as "carry on natively", so no failure mode blocks a user's turn.
 */
export async function askGate(
  baseUrl: string,
  request: GateRequest,
  deps: GateDeps = {},
): Promise<GateAnswer | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? GATE_TIMEOUT_MS);
  try {
    const response = await doFetch(new URL(GATE_PATH, baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(buildGateBody(request)),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      deps.onFailure?.(`answered ${response.status}`);
      return null;
    }
    const parsed = GateResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      deps.onFailure?.(`answered ${response.status} with a body this build cannot read`);
      return null;
    }
    const { action, routerVersion, hint } = parsed.data;
    const category = hint !== undefined ? categoryOf(hint) : undefined;
    return {
      action,
      routerVersion,
      ...(hint !== undefined && category !== undefined ? { hint, category } : {}),
    };
  } catch (err) {
    deps.onFailure?.(`could not be reached (${err instanceof Error ? err.message : String(err)})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
