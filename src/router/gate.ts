/**
 * The hook's time budget for the one routing decision, which the paid route
 * (`POST /api/x402-router/route`) answers before it binds the choice.
 */

/**
 * The hook's whole budget is 5 s (`ROUTE_HOOK_TIMEOUT_SECONDS`, the timeout
 * `install` writes for each routing leg), and the decision gets 3.5 s of it.
 * Inside `tenjin mcp` those 3.5 s hold the paid route too: the 402, the SDK's
 * chain read, the wallet read before a deposit and the paid request. 1.5 s
 * are left for startup, the transcript read and the reply, and 500 ms on a
 * call that carries a deposit ({@link DEPOSIT_GATE_TIMEOUT_MS}); `wire.test.ts`
 * pins the sums. The expected wait is about 1 s.
 *
 * An abort here loses the hint, not the turn: the hook falls back to a line
 * telling the model to call `request` with its own query. A 1.5 s abort
 * swallowed one in four live prompts, so this keeps the slack.
 */
export const GATE_TIMEOUT_MS = 3_500;

/**
 * A call that carries a deposit gets the rest of the hook leg: the first paid
 * call on a channel waits on verify, the gate and the on-chain deposit in a
 * row (5.0 s measured on Base). It is the leg's 5 s less 500 ms for startup,
 * the transcript read and the reply, so the leg never outruns the timeout
 * `install` writes; `wire.test.ts` pins that.
 */
export const DEPOSIT_GATE_TIMEOUT_MS = 4_500;
