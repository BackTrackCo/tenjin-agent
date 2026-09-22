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
    expect(validateResultBody(schema, 'x'.repeat(200 * 1024)).reason).toContain('validation limit');
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

/**
 * A refusal a catalog owner has to act on. During the live smoke the text
 * stopped at "fails the success rule it was paid under", which could not tell
 * a provider whose parse missed from one that answered HTML.
 */
describe('what a failed result contract reports', () => {
  const schema = {
    type: 'object',
    properties: { success: { const: true } },
    required: ['success'],
  };

  it('names the rule that failed on a JSON body that does not satisfy it', () => {
    const check = validateResultBody(schema, JSON.stringify({ success: false, note: 'no match' }));
    expect(check.valid).toBe(false);
    expect(check.diagnosis).toMatchObject({
      json: true,
      failed: expect.stringContaining('/success') as unknown as string,
    });
    expect(check.diagnosis?.preview).toContain('success');
    expect(check.diagnosis?.bytes).toBeGreaterThan(0);
    expect(check.diagnosis?.maxBytes).toBe(128 * 1024);
  });

  it('says the body was not JSON at all, and shows a bounded piece of it', () => {
    const html = `<!doctype html><title>502 Bad Gateway</title>${'x'.repeat(900)}`;
    const check = validateResultBody(schema, html);
    expect(check.diagnosis).toMatchObject({ failed: 'not-json', json: false });
    expect(check.diagnosis?.preview).toContain('502 Bad Gateway');
    expect(check.diagnosis!.preview.length).toBeLessThanOrEqual(301);
  });

  it('says it was too large, with the size and the cap', () => {
    const check = validateResultBody(schema, JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(check.diagnosis).toMatchObject({ failed: 'too-large', maxBytes: 128 * 1024 });
    expect(check.diagnosis!.bytes).toBeGreaterThan(128 * 1024);
  });

  it('redacts anything that looks like a key out of the preview', () => {
    const secret = `ghp_${'A'.repeat(36)}`;
    const check = validateResultBody(schema, `not json, token ${secret}`);
    expect(check.diagnosis?.preview).not.toContain(secret);
  });

  it('says nothing at all when the body satisfies the rule', () => {
    expect(validateResultBody(schema, JSON.stringify({ success: true }))).toEqual({ valid: true });
  });
});
