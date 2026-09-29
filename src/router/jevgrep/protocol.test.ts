import { describe, expect, it } from 'vitest';
import {
  JEV_MAX_QUESTIONS,
  JEV_MODEL,
  validateNativeRequest,
  validateNativeResponse,
} from './protocol.js';

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
    [72, ['q', 'scope']],
    [128, ['q', 'scope']],
    [128, ['q', 'scope', 'ref']],
  ] as const)(
    'accepts the qualified runtime evidence questions for %i declarations',
    (count, kinds) => {
      const questions = Object.fromEntries(
        kinds.flatMap((kind) =>
          Array.from({ length: count }, (_, index) => [
            `${kind}${index}`,
            { type: 'noul', instructions: `Apply state.criteria.${kind} to declaration ${index}.` },
          ]),
        ),
      );
      const input = { ...request, questions };
      expect(validateNativeRequest(input)).toEqual(input);
      const answers = Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.75 }]),
      );
      expect(validateNativeResponse({ answers }, validateNativeRequest(input)).answers).toEqual(
        answers,
      );
    },
  );
  it('rejects more questions than the qualified runtime can emit', () => {
    const questions = Object.fromEntries(
      Array.from({ length: JEV_MAX_QUESTIONS + 1 }, (_, index) => [
        `q${index}`,
        { type: 'noul', instructions: 'Relevant?' },
      ]),
    );
    expect(() => validateNativeRequest({ ...request, questions })).toThrow(
      'Invalid question count',
    );
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
