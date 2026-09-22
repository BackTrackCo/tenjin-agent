import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { mask } from './redact';

/**
 * JSON Schema validation for anything a remote party asks this CLI to send or
 * accepts back: the router's decision arguments, and a result body a caller
 * declared a success condition for. Ported from the draft auto-mode experiment
 * (PR #369 `contracts.ts`) into a shared path so `tenjin pay` gets it too.
 *
 * SCHEMAS ARE UNTRUSTED INPUT. Ajv compiles keywords, never merchant code, but a
 * schema still reaches a compiler, so the checks below run BEFORE compilation:
 * bounded size and nesting, no prototype-poisoning keys, no remote `$ref`, and
 * no regular-expression keyword until a bounded regexp runtime exists. A schema
 * that fails any of them is refused rather than compiled.
 */

export type JsonRecord = Record<string, unknown>;

const MAX_SCHEMA_BYTES = 96 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_DEPTH = 24;
const VALIDATOR_CACHE_LIMIT = 128;

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** Key-order-independent serialization, so one schema has one cache identity. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The stable SHA-256 of a value; the identity a decision row and a duplicate
 *  guard key are built from. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function walk(value: unknown, schemaMode: boolean, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('Schema or value exceeds the nesting limit.');
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, schemaMode, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error(`Forbidden object key: ${key}`);
    }
    if (schemaMode && key === '$ref' && typeof entry === 'string' && !entry.startsWith('#/')) {
      throw new Error('Remote or recursive schema references are unsupported.');
    }
    if (schemaMode && (key === 'pattern' || key === 'patternProperties')) {
      throw new Error('Regular-expression schema constraints are unsupported.');
    }
    walk(entry, schemaMode, depth + 1);
  }
}

const validators = new Map<string, ValidateFunction>();

function compile(schema: JsonRecord): ValidateFunction {
  if (Buffer.byteLength(stable(schema)) > MAX_SCHEMA_BYTES) {
    throw new Error('Schema exceeds its size limit.');
  }
  const key = canonicalHash(schema);
  const cached = validators.get(key);
  if (cached !== undefined) return cached;
  walk(schema, true);
  const options = {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allErrors: false,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allowUnionTypes: true,
  };
  const ajv = schema.$schema === DRAFT_07 ? new Ajv(options) : new Ajv2020(options);
  // A nested body schema can declare draft-07 under a 2020 parent. Registering
  // the meta-schema keeps the dialect's keywords checked and loads nothing
  // remote; Ajv's own remote loading stays off.
  if (!ajv.getSchema(DRAFT_07)) ajv.addMetaSchema({ $id: DRAFT_07 });
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  if (validators.size >= VALIDATOR_CACHE_LIMIT) {
    validators.delete(validators.keys().next().value!);
  }
  validators.set(key, compiled);
  return compiled;
}

export interface SchemaCheck {
  valid: boolean;
  errors: string[];
}

/**
 * Check a value against its own schema. Both are untrusted: the value is
 * round-tripped through JSON first so an exotic JS object can never reach the
 * validator, and its size is bounded before anything is compiled.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): SchemaCheck {
  try {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('A schema must be a JSON Schema object.');
    }
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > MAX_VALUE_BYTES) {
      throw new Error('The value is not JSON, or exceeds its size limit.');
    }
    walk(value, false);
    const validate = compile(schema as JsonRecord);
    if (validate(value)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      ),
    };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** Compile a success schema before a payment is signed, so a broken rule refuses
 *  at the cheap end rather than after money moved. */
export function assertResultSchema(schema: unknown): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('A result success schema must be a JSON Schema object.');
  }
  compile(schema as JsonRecord);
}

export interface ResultCheck {
  valid: boolean;
  reason?: string;
  /**
   * WHAT A CATALOG OWNER NEEDS to tell one failure from another: a provider
   * whose parse missed looks exactly like one that answered HTML, and the
   * reason alone could not separate them during the live smoke.
   */
  diagnosis?: {
    /** `not-json`, `too-large`, or the schema rule that rejected it. */
    failed: string;
    json: boolean;
    bytes: number;
    maxBytes: number;
    /** First 300 characters, redacted. Other people's content, never instructions. */
    preview: string;
  };
}

/** A bounded, redacted look at the body, for a refusal a human has to act on. */
function preview(body: string): string {
  const flat = mask(body).replace(/\s+/g, ' ').trim();
  return flat.length <= 300 ? flat : `${flat.slice(0, 300)}…`;
}

/**
 * HTTP success and APPLICATION success are separate facts. A 200 whose body
 * fails the caller's declared success schema is a failure, and no success field
 * is ever inferred from the body itself.
 */
export function validateResultBody(schema: unknown, body: string): ResultCheck {
  const bytes = Buffer.byteLength(body);
  const base = { json: false, bytes, maxBytes: MAX_BODY_BYTES, preview: preview(body) };
  if (bytes > MAX_BODY_BYTES) {
    return {
      valid: false,
      reason: `The result is ${bytes} bytes, over the ${MAX_BODY_BYTES} byte validation limit.`,
      diagnosis: { ...base, failed: 'too-large' },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
    walk(value, false);
  } catch (err) {
    return {
      valid: false,
      reason: `The result is not a supported bounded JSON document (${err instanceof Error ? err.message : String(err)}).`,
      diagnosis: { ...base, failed: 'not-json' },
    };
  }
  const check = validateAgainstSchema(schema, value);
  if (check.valid) return { valid: true };
  const failed = check.errors[0] ?? 'the success rule';
  return {
    valid: false,
    reason: `The result does not satisfy its success schema: ${failed}`,
    diagnosis: { ...base, json: true, failed },
  };
}
