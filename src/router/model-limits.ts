export const MODEL_ROUTE_BODY_BYTES = 16_384;
export const MODEL_ROUTE_ENVELOPE_BYTES = 64;
export const MODEL_CODEX_TASK_BYTES = 16_000;
export const MODEL_NATIVE_TEXT_BYTES = 256_000;
/** The output cap a side request keeps (the auto-mode classifier's own, a search): the
 *  least a worker's own turn asks for by default. */
export const MODEL_OUTPUT_TOKENS = 65_536;
/**
 * The least output a call is stepped down to when the job's ceiling cannot hold more. The
 * router accepts any `max_tokens` from 1 (its contract), so this is Tenjin's own floor: a
 * reply of this size is still useful, and the call still goes on when little is left.
 */
export const MODEL_OUTPUT_FLOOR_TOKENS = 8_192;
/** The DeepSeek harness's output cap per request, and the most this CLI asks for: Claude
 *  Code 2.1.325 and 2.1.328 took a reply of that many reported tokens whole. */
export const MODEL_OUTPUT_TOKENS_MAX = 256_000;
/**
 * THE OUTPUT CAP OF A JOB'S MODEL CALLS: what its router's offer says its Messages endpoint
 * accepts (`maxOutputTokens`), up to 256,000, the DeepSeek harness's cap (operator ruling
 * 2026-11-18). The offer always names it; an offer that does not is invalid and the call
 * stays native.
 */
export function offeredOutputTokens(decision: Record<string, unknown>): number {
  const offered = decision.maxOutputTokens;
  if (typeof offered !== 'number' || !Number.isSafeInteger(offered) || offered <= 0)
    throw new Error('The offer names no output cap');
  return Math.min(offered, MODEL_OUTPUT_TOKENS_MAX);
}
/** The context of the DeepSeek model a worker runs on. */
export const MODEL_CONTEXT_TOKENS = 1_048_576;
/** The room the DeepSeek harness leaves above its compaction trigger for a request's own overhead. */
const COMPACT_HEADROOM_TOKENS = 65_536;
/**
 * WHERE A WORKER COMPACTS ITS CONVERSATION, as the DeepSeek harness's `compaction-basic`
 * does at its defaults (read in its source, `config.ts`): `floor(min(0.8 * window, window -
 * reply cap - 65,536 headroom))`, with the reply cap of the job's own calls. 838,860 at
 * 65,536, 727,040 at 256,000. A fixed value leaves a reply that is allowed to be longer
 * without room: 786,432 and a 256,000 reply is 1,042,432 of 1,048,576.
 * This is the WINDOW Claude Code reads from `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. It takes
 * `min(its max output tokens, 20,000) + 13,000` off the window (read in 2.1.327), so compaction
 * fires 33,000 tokens earlier than this value: about 805,860 and 694,040.
 */
export function compactWindowTokens(outputCap: number): number {
  return Math.floor(
    Math.min(
      MODEL_CONTEXT_TOKENS * 0.8,
      MODEL_CONTEXT_TOKENS - outputCap - COMPACT_HEADROOM_TOKENS,
    ),
  );
}
/**
 * THE MINUTE THE CLIENT LEAVES over the deadline an offer names, so the router's own cut
 * arrives before the client's. A client that gave up first would end a call the router is
 * still serving, and its charge would be uncertain.
 */
const MODEL_PAID_CALL_MARGIN_MS = 60_000;
/**
 * THE WAIT FOR ONE PAID CALL ON THIS JOB'S ROUTER: the `maxCallDurationMs` its offer names
 * (a non-negative integer, the router's total deadline for one call) plus the margin. A
 * router that allows longer is waited on longer, one that allows less is not waited on past
 * its word. The offer always names it; an offer that does not is invalid.
 */
export function paidCallTimeoutMs(decision: Record<string, unknown>): number {
  const offered = decision.maxCallDurationMs;
  if (typeof offered !== 'number' || !Number.isSafeInteger(offered) || offered < 0)
    throw new Error('The offer names no call deadline');
  // Clamped to the longest wait a timer holds: a longer one would fire after 1 ms.
  return Math.min(offered + MODEL_PAID_CALL_MARGIN_MS, 2 ** 31 - 1);
}
/** Request-body bytes the router counts as one input token in a quote. Mirrors the router. */
const QUOTE_BYTES_PER_INPUT_TOKEN = 3;
/**
 * The router's peak Messages quote, as its `quoteAtomic` makes it (tariff
 * deepseek-flash-1017-2026-11-13): one input token for each 3 bytes of request body (rounded
 * up) plus 4096 framing, at most the 1,048,576-token context, at 300 per thousand, the
 * requested output at 1,200 per thousand, rounded up, then the 5% proxy fee rounded up.
 */
export function modelPeakQuoteAtomic(bytes: number, outputTokens: number): bigint {
  const usage =
    (BigInt(Math.min(1_048_576, Math.ceil(bytes / QUOTE_BYTES_PER_INPUT_TOKEN) + 4096)) * 300n +
      BigInt(outputTokens) * 1200n +
      999n) /
    1000n;
  return usage + (usage * 5n + 99n) / 100n;
}
/**
 * THE LARGEST OUTPUT CAP, FROM `asked` DOWN, WHOSE PEAK QUOTE FITS `remaining` of a job's
 * ceiling for a request of `bytes`. A quote reserves the input (each 3 bytes of body counted as a
 * token, at the full input rate, up to the context) and the output a call asks for, so near
 * the end of a job's ceiling the call asks for less output and the job goes on. Never below
 * 8,192: under that the call's quote is above what is left and the budget rule decides.
 */
export function fittingOutputTokens(bytes: number, asked: number, remaining: bigint): number {
  if (asked <= MODEL_OUTPUT_FLOOR_TOKENS || modelPeakQuoteAtomic(bytes, asked) <= remaining)
    return asked;
  let fits = MODEL_OUTPUT_FLOOR_TOKENS;
  let over = asked;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (modelPeakQuoteAtomic(bytes, middle) <= remaining) fits = middle;
    else over = middle;
  }
  return fits;
}
/**
 * The least job ceiling Tenjin offers a job under, and the floor configuration refuses below:
 * one call at 65,536 output tokens with no body, so a job can pay a normal call and its fee.
 */
export const MODEL_MINIMUM_CALL_ATOMIC = modelPeakQuoteAtomic(0, MODEL_OUTPUT_TOKENS);
/** The least a call can reserve: no body, the 8,192 output tokens it steps down to. */
export const MODEL_FLOOR_CALL_ATOMIC = modelPeakQuoteAtomic(0, MODEL_OUTPUT_FLOOR_TOKENS);
/** A floor in dollars as the CLI prints it: `$0.083866`. */
export const usdOfAtomic = (atomic: bigint): string => '$' + (Number(atomic) / 1e6).toFixed(6);
/** Full hosted POST receipt or owner-GET JSON envelope, including escaped wire and metadata. */
export const MODEL_RESPONSE_ENVELOPE_BYTES = 4_500_000;
/** The smallest result size a router's offer may name, and the smallest a call may state:
 *  the floor the router's own contract takes. */
export const MODEL_MESSAGES_RESULT_BYTES = 2_000_000;
/** The largest this CLI reads from a router whose offer says it honours a stated size. */
export const MODEL_MESSAGES_RESULT_BYTES_MAX = 4_000_000;
/** Raw wire has this upper bound; its complete JSON envelope must also fit above. */
export const MODEL_RESPONSES_WIRE_BYTES = MODEL_RESPONSE_ENVELOPE_BYTES;
/** The router refuses a Messages request that offers more tools than this. */
export const MODEL_MESSAGES_MAX_TOOLS = 256;
