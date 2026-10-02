import { describe, expect, it } from 'vitest';
import {
  assertResultSchema,
  canonicalHash,
  MAX_BODY_BYTES,
  projectBody,
  validateAgainstSchema,
  validateResultBody,
} from './request-schema';

/** One byte past the result cap, as a JSON document. */
const OVER_CAP = JSON.stringify({ blob: 'x'.repeat(MAX_BODY_BYTES) });

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
    expect(validateResultBody(schema, OVER_CAP).reason).toContain('validation limit');
  });

  /**
   * AN ORDINARY PROVIDER BODY IS CHECKED. An Apollo person hit is 60-180 KB;
   * one past 64 KB was refused by the input cap, and one past 128 KB never
   * checked, so a good match came back unverified either way.
   */
  it('checks a 150 KB body against its rule, and passes one that satisfies it', () => {
    const body = JSON.stringify({ data: { organization: { blurb: 'x'.repeat(150 * 1024) } } });
    expect(Buffer.byteLength(body)).toBeGreaterThan(150 * 1024);
    expect(validateResultBody(schema, body)).toEqual({ valid: true });
    const miss = JSON.stringify({ error: 'x'.repeat(150 * 1024) });
    expect(validateResultBody(schema, miss)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('/ must have required property') as unknown as string,
    });
    expect(validateResultBody(schema, miss).unvalidated).toBeUndefined();
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
    expect(check.diagnosis?.maxBytes).toBe(MAX_BODY_BYTES);
  });

  it('says the body was not JSON at all, and shows a bounded piece of it', () => {
    const html = `<!doctype html><title>502 Bad Gateway</title>${'x'.repeat(900)}`;
    const check = validateResultBody(schema, html);
    expect(check.diagnosis).toMatchObject({ failed: 'not-json', json: false });
    expect(check.diagnosis?.preview).toContain('502 Bad Gateway');
    expect(check.diagnosis!.preview.length).toBeLessThanOrEqual(301);
  });

  it('says it was too large, with the size and the cap', () => {
    const check = validateResultBody(schema, OVER_CAP);
    expect(check.diagnosis).toMatchObject({ failed: 'too-large', maxBytes: MAX_BODY_BYTES });
    expect(check.diagnosis!.bytes).toBeGreaterThan(MAX_BODY_BYTES);
  });

  /**
   * COULD NOT CHECK, not "failed the check". The limit is this client's own
   * constant, which the caller's success rule knows nothing about, so callers
   * deliver such a body with a caveat rather than calling the endpoint's
   * contract broken (and, on a paid leg, charging for a discarded result).
   */
  it('marks an over-limit body unvalidated, and a rejected one not', () => {
    const tooLarge = validateResultBody(schema, OVER_CAP);
    expect(tooLarge.valid).toBe(false);
    expect(tooLarge.unvalidated).toBe(true);
    expect(tooLarge.reason).toContain('not checked');

    const rejected = validateResultBody(schema, JSON.stringify({ success: false }));
    expect(rejected.valid).toBe(false);
    expect(rejected.unvalidated).toBeUndefined();

    const notJson = validateResultBody(schema, '<html>502</html>');
    expect(notJson.unvalidated).toBeUndefined();
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

/**
 * THE FIELDS A SPEC PROMISES. Ajv's `removeAdditional: 'all'`: every property
 * the schema does not declare goes, through objects and array items; what the
 * schema does not describe stays as it is; and nothing is ever refused.
 */
describe('cutting a result to the fields its spec promises', () => {
  const PERSON = {
    type: 'object',
    properties: {
      person: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          organization: { type: 'object', properties: { name: { type: 'string' } } },
          employment_history: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' } } },
          },
        },
      },
    },
  };

  it('keeps only the declared properties, through nested objects and array items', () => {
    const body = JSON.stringify({
      person: {
        name: 'Patrick Collison',
        email: 'patrick@stripe.com',
        photo_url: 'https://example.test/p.jpg',
        organization: { name: 'Stripe', technologies: ['a', 'b'], blurb: 'x'.repeat(1000) },
        employment_history: [{ title: 'CEO', description: 'long' }, { kind: 'school' }],
      },
      breadcrumbs: [{ label: 'x' }],
    });
    expect(projectBody(PERSON, body)).toEqual({
      value: {
        person: {
          name: 'Patrick Collison',
          email: 'patrick@stripe.com',
          organization: { name: 'Stripe' },
          employment_history: [{ title: 'CEO' }, {}],
        },
      },
    });
  });

  it('keeps a value of another type, and an object schema with no properties, whole', () => {
    expect(projectBody(PERSON, JSON.stringify({ person: 'none', other: 1 }))).toEqual({
      value: { person: 'none' },
    });
    expect(projectBody(PERSON, JSON.stringify([{ person: {} }]))).toEqual({
      value: [{ person: {} }],
    });
    expect(projectBody({ type: 'object' }, JSON.stringify({ a: { b: 1 } }))).toEqual({
      value: { a: { b: 1 } },
    });
  });

  it('cuts past a missing required field or a wrong type: it never refuses', () => {
    const schema = {
      type: 'object',
      required: ['missing'],
      properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: {} } } },
    };
    expect(projectBody(schema, JSON.stringify({ a: 5, b: { c: 1, d: 2 }, e: 3 }))).toEqual({
      value: { a: 5, b: { c: 1 } },
    });
  });

  it('cuts nothing it cannot read: not JSON, over the cap, a prototype key, or a schema it cannot compile', () => {
    expect(projectBody(PERSON, '<html>502</html>')).toBeUndefined();
    expect(projectBody(PERSON, OVER_CAP)).toBeUndefined();
    expect(
      projectBody({ type: 'object', properties: { a: { $ref: 'https://evil/x' } } }, '{}'),
    ).toBeUndefined();
    expect(projectBody(null, '{}')).toBeUndefined();
    expect(projectBody(PERSON, '{"person": {"__proto__": {"polluted": true}}}')).toBeUndefined();
  });
});
