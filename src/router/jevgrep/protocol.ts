/** The native TypeSafe evaluation transport used by Jevgrep, not chat completions. */
export const JEV_MODEL = 'jev-1.13.0' as const;
export const JEV_LIMITS = {
  concurrency: 2,
  requests: 60,
  // Cache hits use no paid/egress budget, but the local child remains bounded.
  localRequests: 4096,
  localRequestBytes: 64 * 1024 * 1024,
  requestBytes: 128 * 1024,
  totalRequestBytes: 2 * 1024 * 1024,
  responseBytes: 256 * 1024,
  outputBytes: 16 * 1024,
} as const;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type NativeEvaluationRequest = {
  model: typeof JEV_MODEL;
  state: JsonValue;
  questions: Record<string, { type: 'noul'; instructions: string }>;
};
export type NativeEvaluationResponse = {
  answers: Record<string, { type: 'noul'; noul: number }>;
  model?: string;
  usage?: { input_tokens: number; output_tokens?: number };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysOnly(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((child) => jsonValue(child, depth + 1));
  return record(value) && Object.values(value).every((child) => jsonValue(child, depth + 1));
}
function boundedJson(value: unknown, bytes: number) {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && Buffer.byteLength(encoded) <= bytes;
  } catch {
    return false;
  }
}

export function validateNativeRequest(value: unknown): NativeEvaluationRequest {
  if (
    !record(value) ||
    !keysOnly(value, ['model', 'state', 'questions']) ||
    value.model !== JEV_MODEL ||
    !Object.hasOwn(value, 'state') ||
    !jsonValue(value.state) ||
    !record(value.questions) ||
    !boundedJson(value, JEV_LIMITS.requestBytes)
  )
    throw new Error('Invalid native evaluation request');
  const questions = Object.entries(value.questions);
  if (questions.length < 1 || questions.length > 128) throw new Error('Invalid question count');
  for (const [id, question] of questions) {
    if (
      !id ||
      id.length > 256 ||
      [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !record(question) ||
      !keysOnly(question, ['type', 'instructions']) ||
      question.type !== 'noul' ||
      typeof question.instructions !== 'string' ||
      question.instructions.length > 32_768
    )
      throw new Error('Invalid native evaluation question');
  }
  return value as NativeEvaluationRequest;
}

export function validateNativeResponse(
  value: unknown,
  request: NativeEvaluationRequest,
): NativeEvaluationResponse {
  if (!record(value) || !record(value.answers) || !boundedJson(value, JEV_LIMITS.responseBytes)) {
    throw new Error('Invalid native evaluation response');
  }
  const ids = Object.keys(request.questions);
  if (
    Object.keys(value.answers).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(value.answers as object, id)) ||
    (value.model !== undefined && value.model !== request.model)
  )
    throw new Error('Native evaluation response does not match request');
  const answers: NativeEvaluationResponse['answers'] = Object.fromEntries(
    ids.map((id) => {
      const answer = (value.answers as Record<string, unknown>)[id];
      if (
        !record(answer) ||
        answer.type !== 'noul' ||
        typeof answer.noul !== 'number' ||
        !Number.isFinite(answer.noul) ||
        answer.noul < 0 ||
        answer.noul > 1
      )
        throw new Error('Invalid native evaluation probability');
      return [id, { type: 'noul' as const, noul: answer.noul }];
    }),
  );
  const result: NativeEvaluationResponse = { answers };
  if (typeof value.model === 'string') result.model = value.model;
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (
      !record(usage) ||
      !Number.isSafeInteger(usage.input_tokens) ||
      (usage.input_tokens as number) < 0 ||
      (usage.output_tokens !== undefined &&
        (!Number.isSafeInteger(usage.output_tokens) || (usage.output_tokens as number) < 0))
    )
      throw new Error('Invalid native evaluation usage');
    result.usage = {
      input_tokens: usage.input_tokens as number,
      ...(usage.output_tokens !== undefined
        ? { output_tokens: usage.output_tokens as number }
        : {}),
    };
  }
  return result;
}
