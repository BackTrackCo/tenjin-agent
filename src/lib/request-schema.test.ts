import { describe, expect, it } from 'vitest';
import {
  assertResultSchema,
  canonicalHash,
  validateAgainstSchema,
  validateResultBody,
} from './request-schema';

const QUOTE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { symbol: { type: 'string' }, convert: { type: 'string' } },
  required: ['symbol'],
  additionalProperties: false,
};

describe('argument validation', () => {
  it('accepts a value its schema describes and refuses one it does not', () => {
    expect(validateAgainstSchema(QUOTE_SCHEMA, { symbol: 'BTC,ETH', convert: 'USD' })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateAgainstSchema(QUOTE_SCHEMA, { convert: 'USD' }).valid).toBe(false);
    expect(validateAgainstSchema(QUOTE_SCHEMA, { symbol: 'BTC', extra: 1 }).valid).toBe(false);
    expect(validateAgainstSchema(QUOTE_SCHEMA, { symbol: 7 }).valid).toBe(false);
  });

  it('names the failing field so a refusal is actionable', () => {
    const check = validateAgainstSchema(QUOTE_SCHEMA, { symbol: 7 });
    expect(check.errors[0]).toContain('/symbol');
  });

  it.each([
    ['a remote reference', { type: 'object', properties: { a: { $ref: 'https://evil/x.json' } } }],
    ['a regular expression', { type: 'string', pattern: '^(a+)+$' }],
    ['a pattern property map', { type: 'object', patternProperties: { '^(a+)+$': {} } }],
    ['a prototype key', { type: 'object', properties: { ['__proto__']: { type: 'string' } } }],
  ])('refuses a schema carrying %s rather than compiling it', (_label, schema) => {
    expect(validateAgainstSchema(schema, { a: 'x' }).valid).toBe(false);
    expect(() => assertResultSchema(schema)).toThrow();
  });

  it('refuses a schema that is not an object, and a value that is not JSON', () => {
    expect(validateAgainstSchema(null, {}).valid).toBe(false);
    expect(validateAgainstSchema([], {}).valid).toBe(false);
    expect(validateAgainstSchema(QUOTE_SCHEMA, { symbol: 1n as unknown }).valid).toBe(false);
  });

  it('bounds nesting and value size before anything is compiled', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(validateAgainstSchema({ type: 'object' }, deep).valid).toBe(false);
    const huge = { symbol: 'x'.repeat(70 * 1024) };
    expect(validateAgainstSchema(QUOTE_SCHEMA, huge).valid).toBe(false);
  });
});

describe('result body validation', () => {
  const schema = {
    type: 'object',
    properties: { data: { type: 'object' } },
    required: ['data'],
  };

  it('separates HTTP success from application success', () => {
    expect(validateResultBody(schema, JSON.stringify({ data: { BTC: 1 } }))).toEqual({
      valid: true,
    });
    const missing = validateResultBody(schema, JSON.stringify({ status: 'error' }));
    expect(missing.valid).toBe(false);
    expect(missing.reason).toContain('success schema');
  });

  it('refuses a non-JSON body and one past the size limit', () => {
    expect(validateResultBody(schema, 'not json').valid).toBe(false);
    expect(validateResultBody(schema, 'x'.repeat(200 * 1024)).reason).toContain('size limit');
  });
});

describe('canonical hashing', () => {
  it('ignores key order so one request has one identity', () => {
    expect(canonicalHash({ a: 1, b: [2, { c: 3 }] })).toBe(
      canonicalHash({ b: [2, { c: 3 }], a: 1 }),
    );
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
