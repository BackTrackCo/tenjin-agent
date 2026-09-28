import { describe, expect, it } from 'vitest';
import { JEV_MODEL, validateNativeRequest, validateNativeResponse } from './protocol.js';

const request = {
  model: JEV_MODEL,
  state: { source: 'export function verify() {}' },
  questions: { q: { type: 'noul', instructions: 'Is this relevant?' } },
};
describe('native Jev transport validation', () => {
  it('accepts structured source state and native probabilities without fabricating usage', () => {
    const parsed = validateNativeRequest(request);
    expect(
      validateNativeResponse(
        {
          model: JEV_MODEL,
          answers: { q: { type: 'noul', noul: 0.8 } },
          usage: { input_tokens: 100 },
        },
        parsed,
      ),
    ).toEqual({
      model: JEV_MODEL,
      answers: { q: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 100 },
    });
    expect(
      validateNativeResponse({ answers: { q: { type: 'noul', noul: 0 } } }, parsed).usage,
    ).toBeUndefined();
  });
  it.each([
    { ...request, model: 'other-model' },
    { ...request, messages: [] },
    { ...request, questions: {} },
    { ...request, state: 'x'.repeat(128 * 1024) },
    { ...request, questions: { q: { type: 'boolean', instructions: 'x' } } },
  ])('rejects unsupported request shape', (value) => {
    expect(() => validateNativeRequest(value)).toThrow();
  });
  it.each([
    { answers: {} },
    { answers: { q: { type: 'noul', noul: 2 } } },
    { answers: { q: { type: 'noul', noul: NaN } } },
    { answers: { q: { type: 'noul', noul: 0.5 }, extra: { type: 'noul', noul: 0.2 } } },
    { model: 'other-model', answers: { q: { type: 'noul', noul: 0.5 } } },
    { answers: { q: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: -1 } },
  ])('rejects mismatched or invalid answers', (value) => {
    expect(() => validateNativeResponse(value, validateNativeRequest(request))).toThrow();
  });
});
