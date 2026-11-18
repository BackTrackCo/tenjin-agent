export const MODEL_ROUTE_BODY_BYTES = 16_384;
export const MODEL_ROUTE_ENVELOPE_BYTES = 64;
export const MODEL_CODEX_TASK_BYTES = 16_000;
export const MODEL_NATIVE_TEXT_BYTES = 256_000;
/** A worker's output cap per request: the most the bridge and the router's contract take
 *  today (operator ruling 2026-11-17; the DeepSeek harness asks 256,000 once the router does). */
export const MODEL_OUTPUT_TOKENS = 65_536;
/** The routing fee's ceiling, which a job's ceiling also covers. */
export const MODEL_ROUTING_FEE_CEILING_ATOMIC = 3_000n;
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
/** The least quote a worker's request can have: no body, the full output cap. */
export const MODEL_MINIMUM_CALL_ATOMIC = modelPeakQuoteAtomic(0, MODEL_OUTPUT_TOKENS);
/** Necessary floor: one such call and the routing fee. Actual system/tools/history increase
 *  the quote; this is not a sufficiency guarantee. Derived from the cap, so the two move together. */
export const MODEL_MINIMUM_JOB_ATOMIC =
  MODEL_MINIMUM_CALL_ATOMIC + MODEL_ROUTING_FEE_CEILING_ATOMIC;
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
