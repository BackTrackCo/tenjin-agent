export const MODEL_ROUTE_BODY_BYTES = 16_384;
export const MODEL_ROUTE_ENVELOPE_BYTES = 64;
export const MODEL_CODEX_TASK_BYTES = 16_000;
export const MODEL_NATIVE_TEXT_BYTES = 256_000;
export const MODEL_EXPECTED_SPEND_ATOMIC = '20000';
/** Necessary floor at tariff deepseek-flash-1017-2026-11-13: 32K output,
 *  4096 framing input, peak rates, separately rounded 5% proxy fee, plus route.
 *  Actual system/tools/history increase the quote; this is not a sufficiency guarantee. */
export const MODEL_MINIMUM_JOB_ATOMIC = 44_611n;
/** Full hosted POST receipt or owner-GET JSON envelope, including escaped wire and metadata. */
export const MODEL_RESPONSE_ENVELOPE_BYTES = 4_500_000;
export const MODEL_MESSAGES_RESULT_BYTES = 2_000_000;
/** Raw wire has this upper bound; its complete JSON envelope must also fit above. */
export const MODEL_RESPONSES_WIRE_BYTES = MODEL_RESPONSE_ENVELOPE_BYTES;
