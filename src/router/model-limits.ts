export const MODEL_ROUTE_BODY_BYTES = 16_384;
export const MODEL_ROUTE_ENVELOPE_BYTES = 64;
export const MODEL_CODEX_TASK_BYTES = 16_000;
export const MODEL_NATIVE_TEXT_BYTES = 256_000;
/** A worker's output cap per request on a router whose offer names none: the most that
 *  router's contract takes. The least a job needs is derived from it for every router. */
export const MODEL_OUTPUT_TOKENS = 65_536;
/** The DeepSeek harness's output cap per request, and the most this CLI asks for: Claude
 *  Code 2.1.325 and 2.1.328 took a reply of that many reported tokens whole. */
export const MODEL_OUTPUT_TOKENS_MAX = 256_000;
/**
 * THE OUTPUT CAP OF A JOB'S MODEL CALLS: what its router's offer says its Messages endpoint
 * accepts (`maxOutputTokens`), up to 256,000, the DeepSeek harness's cap (operator ruling
 * 2026-11-18). Undefined for an offer that names none, such as production's today, which
 * accepts 65,536: read from the offer alone, never guessed from a version.
 */
export function offeredOutputTokens(decision: Record<string, unknown>): number | undefined {
  const offered = decision.maxOutputTokens;
  return typeof offered === 'number' &&
    Number.isSafeInteger(offered) &&
    offered > MODEL_OUTPUT_TOKENS
    ? Math.min(offered, MODEL_OUTPUT_TOKENS_MAX)
    : undefined;
}
/** The context of the DeepSeek model a worker runs on. */
export const MODEL_CONTEXT_TOKENS = 1_048_576;
/** The room the DeepSeek harness leaves above its compaction trigger for a request's own overhead. */
const COMPACT_HEADROOM_TOKENS = 65_536;
/**
 * WHERE A WORKER COMPACTS ITS CONVERSATION, as the DeepSeek harness's `compaction-basic`
 * does at its defaults (read in its source, `config.ts`): `floor(min(0.8 * window, window -
 * reply cap - 65,536 headroom))`, with the reply cap of the job's own calls. 838,860 at
 * 65,536 (production today), 727,040 at 256,000. A fixed value leaves a reply that is
 * allowed to be longer without room: 786,432 and a 256,000 reply is 1,042,432 of 1,048,576.
 */
export function compactWindowTokens(outputCap: number = MODEL_OUTPUT_TOKENS): number {
  return Math.floor(
    Math.min(
      MODEL_CONTEXT_TOKENS * 0.8,
      MODEL_CONTEXT_TOKENS - outputCap - COMPACT_HEADROOM_TOKENS,
    ),
  );
}
/**
 * HOW LONG THE CLIENT WAITS FOR A PAID MODEL CALL'S ANSWER: never less than the router
 * allows it. The router's total deadline for one call is 540 s on the next server (its idle
 * limit is 300 s) and 300 s in production, and its offer advertises neither, so the wait is
 * the longer one with a minute to spare. A client that gave up first would end a call the
 * router is still serving, and its charge would be uncertain.
 */
export const MODEL_PAID_CALL_TIMEOUT_MS = 600_000;
/**
 * The router's peak Messages quote, as its `quoteAtomic` makes it (tariff
 * deepseek-flash-1017-2026-11-13): `bytes` of request body plus 4096 framing, at most the
 * 1,048,576-token context, at 300 per thousand, the requested output at 1,200 per
 * thousand, rounded up, then the 5% proxy fee rounded up.
 */
export function modelPeakQuoteAtomic(bytes: number, outputTokens: number): bigint {
  const usage =
    (BigInt(Math.min(1_048_576, bytes + 4096)) * 300n + BigInt(outputTokens) * 1200n + 999n) /
    1000n;
  return usage + (usage * 5n + 99n) / 100n;
}
/**
 * THE LARGEST OUTPUT CAP, FROM `asked` DOWN, WHOSE PEAK QUOTE FITS `remaining` of a job's
 * ceiling for a request of `bytes`. A quote reserves the output a call asks for, so a
 * 256,000-token call reserves about $0.37 where a 65,536-token one reserves $0.13: near
 * the end of a job's ceiling the call asks for less output and the job goes on. Never
 * below 65,536, where the ceiling's own rule decides, as it always did.
 */
export function fittingOutputTokens(bytes: number, asked: number, remaining: bigint): number {
  if (asked <= MODEL_OUTPUT_TOKENS || modelPeakQuoteAtomic(bytes, asked) <= remaining) return asked;
  let fits = MODEL_OUTPUT_TOKENS;
  let over = asked;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (modelPeakQuoteAtomic(bytes, middle) <= remaining) fits = middle;
    else over = middle;
  }
  return fits;
}
/** The least quote a worker's request can have: no body, the output cap every router takes. */
export const MODEL_MINIMUM_CALL_ATOMIC = modelPeakQuoteAtomic(0, MODEL_OUTPUT_TOKENS);
/** A floor in dollars as the CLI prints it: `$0.086866`. */
export const usdOfAtomic = (atomic: bigint): string => '$' + (Number(atomic) / 1e6).toFixed(6);
/** Full hosted POST receipt or owner-GET JSON envelope, including escaped wire and metadata. */
export const MODEL_RESPONSE_ENVELOPE_BYTES = 4_500_000;
/** The largest completed Messages `message` a router delivers to a client that states no
 *  size, and the largest this CLI reads from one. */
export const MODEL_MESSAGES_RESULT_BYTES = 2_000_000;
/** The largest this CLI reads from a router whose offer says it honours a stated size. */
export const MODEL_MESSAGES_RESULT_BYTES_MAX = 4_000_000;
/** Raw wire has this upper bound; its complete JSON envelope must also fit above. */
export const MODEL_RESPONSES_WIRE_BYTES = MODEL_RESPONSE_ENVELOPE_BYTES;
/** The router refuses a Messages request that offers more tools than this. */
export const MODEL_MESSAGES_MAX_TOOLS = 256;
