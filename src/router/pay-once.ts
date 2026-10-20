import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * PAY ONCE: the in-place front end of the one approval gate. A call over the
 * automatic limits is stopped at the moment its price is firm (the live 402,
 * before anything is signed, `PayArgs.admit`), the same moment the x402 SDK's
 * own payment-requested hook runs. There it is either asked about here, as an
 * MCP form elicitation that Claude Code shows as its own dialog while this
 * process waits, or kept as a quote for the `approve` tool where the client
 * shows no dialog. A yes here keeps and runs that same quote (`plan.ts`), so
 * both front ends write one record and admit one plan: nothing is approved
 * twice, and there is no second ledger.
 *
 * WHY NOT A TOKEN FILE. The agent has Bash and can write any file the user
 * can, so an approval read from disk is one it could mint itself. An
 * elicitation answer travels from Claude Code's dialog to this paying process
 * over the MCP connection, so there is nothing on disk to forge. A user who
 * configures an `Elicitation` hook that auto-accepts has chosen that, the same
 * as raising both limits.
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

/**
 * The asker for one tool call, or undefined when the client did not declare
 * form elicitation: then a call over the limits takes the `approve` path. A
 * form elicitation from a client that declared `elicitation: {}` is form too
 * (the SDK reads an empty object as `{ form: {} }`). It is handed the plan's
 * own sentence, the one `approve` would show.
 */
export function payOnceAsker(
  server: ElicitingServer,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): ((message: string) => Promise<boolean>) | undefined {
  if (server.getClientCapabilities()?.elicitation?.form === undefined) return undefined;
  return async (message) => {
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              [PAY_ONCE_FIELD]: {
                type: 'boolean',
                title: 'Pay once',
                description: 'Pay this price for this one lookup. Your limits stay.',
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
