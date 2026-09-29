import { describe, expect, it } from 'vitest';
import { encodeMapleRequest, validateMapleResponse } from './maple';
import { jevgrepProfile, type JevgrepProfileId } from './profile';
import {
  JEV_MODEL,
  validateNativeRequest,
  type JsonValue,
  type NativeEvaluationRequest,
} from './protocol';

const request: NativeEvaluationRequest = {
  model: JEV_MODEL,
  state: 'function add(a, b) {\n  return a + b;\n}',
  questions: { adds: { type: 'noul', instructions: 'Does the function add its arguments?' } },
};
const response = {
  model: JEV_MODEL,
  answers: { adds: { type: 'noul', noul: 0.99 } },
  usage: { input_tokens: 321, output_tokens: 8 },
};

describe('Maple native SystemOne wire adapter', () => {
  it('uses the provider alias while preserving the exact string state and named questions', () => {
    const original = structuredClone(request);
    expect(JSON.parse(encodeMapleRequest(request))).toEqual({ ...request, model: 'jev-latest' });
    expect(request).toEqual(original);
  });

  it.each<JsonValue>([
    { source: 'a "quoted" value\nnext line', names: ['α', '🍁'] },
    ['source', { line: 12 }],
    null,
    true,
    12,
  ])('serializes a structured state without changing its information: %j', (state) => {
    const wire = JSON.parse(encodeMapleRequest({ ...request, state }));
    expect(typeof wire.state).toBe('string');
    expect(JSON.parse(wire.state)).toEqual(state);
    expect(wire.questions).toEqual(request.questions);
  });

  it.each<[JevgrepProfileId, number]>([
    ['standard-v1', 40_000],
    ['extended-v1', 80_000],
  ])('bounds escaped wire bytes for %s, even when the canonical request fits', (profile, count) => {
    const input = { ...request, state: { source: '"'.repeat(count) } };
    expect(validateNativeRequest(input, profile)).toEqual(input);
    expect(() => encodeMapleRequest(input, profile)).toThrow('adapted evaluation request exceeds');
  });

  it('applies byte rather than character limits to UTF-8 state', () => {
    const limit = jevgrepProfile().limits.requestBytes;
    const prefix = { ...request, state: '🍁' };
    const remaining = limit - Buffer.byteLength(encodeMapleRequest(prefix));
    const input = { ...request, state: '🍁' + 'a'.repeat(remaining) };
    expect(Buffer.byteLength(encodeMapleRequest(input))).toBe(limit);
    expect(() => encodeMapleRequest({ ...input, state: input.state + 'a' })).toThrow();
  });

  it('returns verified pinned provenance and usage without manufacturing either', () => {
    expect(validateMapleResponse(response, request)).toEqual(response);
    const withoutUsage = { model: JEV_MODEL, answers: response.answers };
    expect(validateMapleResponse(withoutUsage, request)).toEqual(withoutUsage);
  });

  it.each([
    { ...response, model: 'jev-latest' },
    { ...response, model: 'jev-1.12.0' },
    { ...response, model: undefined },
    { answers: response.answers },
    { ...response, answers: { wrong: { type: 'noul', noul: 0.99 } } },
    { ...response, answers: { adds: { type: 'choice', noul: 0.99 } } },
    { ...response, answers: { adds: { type: 'noul', noul: 2 } } },
    { ...response, usage: { input_tokens: -1 } },
  ])('rejects unverified model provenance and invalid native answers', (value) => {
    expect(() => validateMapleResponse(value, request)).toThrow();
  });
});
