import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { formatUsdDisplay } from '../lib/money';
import type { OverLimitAsk } from './tool';

/**
 * PAY ONCE: a payment over `maxAutoSpend`, approved by the user for this one
 * call, at the price they were shown. The request tool asks through an MCP
 * form elicitation, which Claude Code shows as its own dialog while this
 * process waits, so it works with or without the mod, on every surface that
 * shows elicitation dialogs. On accept, `gateSpend` re-runs its authorization
 * in automatic mode with `autoSpendApprovalAtomic` set to that exact amount;
 * the price cap, the allowlist, the daily budget and the duplicate guard still
 * refuse. Decline, cancel, a timeout, a client without the capability, or a
 * user `Elicitation` hook that declines all keep today's `needs_approval`.
 *
 * WHY NOT A TOKEN FILE. The first draft had the mod write an approval token
 * under `~/.tenjin` for the request tool to honor. The agent has Bash and can
 * write any file the user can, so it could mint that token itself and get past
 * `maxAutoSpend` with no human. An elicitation answer travels from Claude
 * Code's dialog to this paying process over the MCP connection, so there is
 * nothing on disk to forge, and the approval lives only in the call's memory.
 * A user who configures an `Elicitation` hook that auto-accepts has chosen
 * that, the same as raising `maxAutoSpend`.
 */

/**
 * The SDK's default request timeout is 60 seconds, too short for a person to
 * read a price and answer. Five minutes, and a timeout is a decline.
 */
export const PAY_ONCE_TIMEOUT_MS = 5 * 60_000;

/** The one boolean the form asks for. */
export const PAY_ONCE_FIELD = 'pay';

/** The slice of the SDK's `Server` the ask needs, so a test can fake it. */
export interface ElicitingServer {
  getClientCapabilities(): { elicitation?: { form?: object; url?: object } } | undefined;
  elicitInput(
    params: ElicitRequestFormParams,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ElicitResult>;
}

/** `<label> wants $0.42 for this lookup, over your $0.25 automatic limit. Pay once?` */
export function payOnceMessage(ask: OverLimitAsk, limitAtomic: bigint): string {
  return (
    `${ask.label} wants $${formatUsdDisplay(ask.amountAtomic.toString())} for this lookup, ` +
    `over your $${formatUsdDisplay(limitAtomic.toString())} automatic limit. Pay once?`
  );
}

/**
 * The asker for one tool call, or undefined when the client did not declare
 * form elicitation: then nothing is asked and the refusal stands. A form
 * elicitation from a client that declared `elicitation: {}` is form too
 * (the SDK reads an empty object as `{ form: {} }`).
 */
export function payOnceAsker(
  server: ElicitingServer,
  limitAtomic: () => Promise<bigint>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): ((ask: OverLimitAsk) => Promise<boolean>) | undefined {
  if (server.getClientCapabilities()?.elicitation?.form === undefined) return undefined;
  return async (ask) => {
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message: payOnceMessage(ask, await limitAtomic()),
          requestedSchema: {
            type: 'object',
            properties: {
              [PAY_ONCE_FIELD]: {
                type: 'boolean',
                title: 'Pay once',
                description: 'Pay this price for this one lookup. Your automatic limit stays.',
                default: false,
              },
            },
            required: [PAY_ONCE_FIELD],
          },
        },
        {
          timeout: opts.timeoutMs ?? PAY_ONCE_TIMEOUT_MS,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
      );
      return result.action === 'accept' && result.content?.[PAY_ONCE_FIELD] === true;
    } catch {
      // A timeout, a dropped connection or a malformed answer: no approval.
      return false;
    }
  };
}
