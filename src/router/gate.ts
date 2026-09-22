import { z } from 'zod';
import type { Packet, PendingCall } from './context';

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
export const GATE_TIMEOUT_MS = 2_500;

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
}

export function isWellFormedHint(hint: string): boolean {
  if (hint.length === 0 || hint.length > MAX_HINT_CHARS) return false;
  if (/[\p{Cc}\p{Cf}]/u.test(hint)) return false;
  if (/[`<>*_[\]{}\\]/.test(hint)) return false;
  if (!hint.includes('Call request')) return false;
  if (!hint.endsWith(HINT_TAIL)) return false;
  const lowered = hint.toLowerCase();
  return CATEGORIES.filter((category) => lowered.includes(category)).length === 1;
}

export interface GateRequest {
  source: 'prompt' | 'native';
  packet: Packet;
  pendingCall?: PendingCall;
}

export interface GateDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
      body: JSON.stringify({
        schemaVersion: 1,
        source: request.source,
        packet: request.packet,
        ...(request.pendingCall !== undefined ? { pendingCall: request.pendingCall } : {}),
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return null;
    const parsed = GateResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const { action, routerVersion, hint } = parsed.data;
    return {
      action,
      routerVersion,
      ...(hint !== undefined && isWellFormedHint(hint) ? { hint } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
