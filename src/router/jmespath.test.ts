import { describe, expect, it } from 'vitest';
import { convertWith, expressionProblem } from './jmespath';

describe('the conversion module', () => {
  it('reshapes a body the way a conversion says', () => {
    expect(
      convertWith('{posts: items[].{text: t, by: u.name}}', {
        items: [{ t: 'a', u: { name: 'x' } }],
      }),
    ).toEqual({
      posts: [{ text: 'a', by: 'x' }],
    });
  });

  it('refuses an expression that is not JMESPath, and one over its bound', () => {
    expect(expressionProblem('{{')).toBeDefined();
    expect(expressionProblem('a'.repeat(2_001))).toContain('over');
    expect(() => convertWith('{{', {})).toThrow();
  });
});
