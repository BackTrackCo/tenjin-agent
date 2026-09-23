/**
 * THE HOOK'S TIME BUDGET, which is the only thing this module still owns.
 *
 * There is no separate gate call any more: the hook asks `POST
 * /api/x402-router` for the one free decision, and the backend answers as soon
 * as the native-versus-paid question is settled, binding whatever it chose in
 * the background. What used to live here, the `/prepare` client and the
 * category-shaped hint validator, went with that second round trip.
 */

/**
 * The hook's whole budget is 5 s (the timeout `install` writes). Stdin waits up
 * to 1 s of it, so the decision gets 3.5 s and the two together still leave
 * 500 ms for node's boot and the transcript read; `wire.test.ts` pins the sum.
 * The expected wait is about 1 s: the backend answers on the gate question and
 * binds afterwards.
 *
 * AN ABORT HERE IS A LOST HINT, not a lost turn. The hook falls back to one
 * line telling the model to call `request` with its own query, and the tool
 * makes the decision instead. One of four live prompts was swallowed at a 1.5 s
 * abort against a backend measured at 0.4 to 0.5 s, so this holds the slack the
 * harness budget was already leaving unused.
 */
export const GATE_TIMEOUT_MS = 3_500;
